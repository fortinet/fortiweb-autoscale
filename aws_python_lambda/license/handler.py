import os
import sys
import boto3
import botocore
import logging
import json
from botocore.exceptions import ClientError
import logging
import time
import base64

logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(asctime)s: %(message)s')
logger = logging.getLogger()

MAGIC_CONCATENATOR = '=|fwb|='

class NoAvailableLicense(Exception):
    pass

def GetLicenseFileName(bucket_name, lic_dir_path):
    client = boto3.client('s3')
    licenses = []
    response = client.list_objects(Bucket=bucket_name, Prefix=lic_dir_path)

    for item in response['Contents']:
        if item['Key'].find('.lic') != -1:
            licenses.append(item['Key'])
    logger.debug(licenses)
    return licenses

def get_all_lic_names(bucket_name, lic_dir_path):
    try_count = 10
    lics = []
    while try_count > 0:
        try_count = try_count - 1
        try:
            lics = GetLicenseFileName(bucket_name, lic_dir_path)
            return lics
        except Exception as e:
            logger.error('catch exception while get license name from s3, exception: %s' % (str(e)))
            time.sleep(1)
    raise Exception('get license name from s3 error!')

def put_record_if_not_exists(table_name, lic_abs_name, instance_id):
    lic_name = os.path.basename(lic_abs_name)
    client = boto3.client('dynamodb')
    try:
        #just for query
        combine = instance_id + MAGIC_CONCATENATOR + lic_name
        client.update_item(TableName=table_name,
                Key = {'assigned_records': {'S': 'total_records'}},
                UpdateExpression = 'ADD inst_lic_pair :pair',
                ConditionExpression='not contains(inst_lic_pair, :inst_id) AND not contains(inst_lic_pair, :lic_name)',
                ExpressionAttributeValues = {
                    ":pair": {"SS": [instance_id, lic_name, combine]},
                    ":inst_id": {"S": instance_id},
                    ":lic_name": {"S": lic_name},
                },
            )
    except botocore.exceptions.ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return 1
        raise
    except Exception as e:
        raise
    return 0

def assign_license(table_name, all_lic_names, instance_id):
    lic_index = 0
    while True:
        lic_name = all_lic_names[lic_index]
        logger.debug('try alloc license: %s' % (lic_name))
        ret = put_record_if_not_exists(table_name, lic_name, instance_id)
        if 0 == ret:
            logger.info('alloc license finally get: %s' % (lic_name))
            return lic_name
        elif 1 == ret:
            lic_index += 1
            if lic_index >= len(all_lic_names):
                raise NoAvailableLicense('no available license!')
            time.sleep(0.5)
            continue
        elif -1 == ret:
            time.sleep(0.5)
            continue
        else:
            raise

def parse_event(event):
    ret = None
    body = event['body']
    if event['isBase64Encoded']:
        body = base64.b64decode(body).decode()
    try:
        body_obj = json.loads(body)
        ret = {
            'instance_id': body_obj['instance']
        }
        return ret
    except Exception as e:
        logger.error('get exception when parse event. \r\n%s' % (e))
        return None

def auth_request(instance_id, asgnames):
    all_instances = []
    client = boto3.client('autoscaling')
    try:
        resp = client.describe_auto_scaling_groups(AutoScalingGroupNames=[asgnames])
        for grp in resp['AutoScalingGroups']:
            insts = grp['Instances']
            for i in insts:
                all_instances.append(i['InstanceId'])
    except Exception as e:
        raise
    logger.info('all instances: %s' % (all_instances))
    if instance_id in all_instances:
        return True
    return False

def try_alloc_license(bucket_name, license_dir_path, table_name, instance_id):
    try:
        all_lic_names = get_all_lic_names(bucket_name, license_dir_path)
    except Exception as e:
        raise

    if len(all_lic_names) <= 0:
        logger.error('license dir is empty!')
        #for apigetaway return internal error
        raise NoAvailableLicense('no one license found!')
    try:
        lic_name = assign_license(table_name, all_lic_names, instance_id)
        return lic_name
    except Exception as e:
        raise

def get_assigned_lic_name(table_name, instance_id):
    try:
        client = boto3.client('dynamodb')
        resp = client.get_item(TableName=table_name,
                    Key={'assigned_records': {'S': 'total_records'}}
                    )
        item = resp['Item']
        all_records = item['inst_lic_pair']['SS']
        if 0 != len(all_records) % 3:
            raise Exception('record not paired! manually changed record?')
        for i in all_records:
            if i.startswith(instance_id + MAGIC_CONCATENATOR):
                return i.split(MAGIC_CONCATENATOR)[1]
        return None
    except Exception as e:
        logger.debug('get none from dynamodb. exception: %s' % (str(e)))
        return None

def lambda_handler(event, context):
    logger.debug('event dump:\r\n%s' % (json.dumps(event)))
    evt_parsed = parse_event(event)

    instance_id = evt_parsed['instance_id']
    auth_request(instance_id, os.environ['BYOL_ASG_NAME'])

    bucket_name = os.environ['S3Bucket']
    s3_prefix = os.environ['S3Prefix']
    table_name = os.environ['CUSTOM_ID'] + '-FortiWebLic-' + os.environ['UNIQUE_ID']
    if s3_prefix.startswith('/'):
        s3_prefix = s3_prefix[1:]
    if not s3_prefix.endswith('/'):
        s3_prefix = s3_prefix + '/'
    license_dir_path = s3_prefix + 'license/'

    lic_s3_path = 'none'
    lic_name = None
    statusCode = 200
    try:
        lic_name = get_assigned_lic_name(table_name, instance_id)
        if None == lic_name:
            #if-then can not avoid concurrency problem, but our client will try again, finally will get right result
            try:
                lic_name = try_alloc_license(bucket_name, license_dir_path, table_name, instance_id)
            except NoAvailableLicense as e:
                statusCode = 404
            except Exception:
                statusCode = 500
                #trigger gateway 500
                raise
            else:
                statusCode = 200
        if 200 == statusCode:
            lic_s3_path = 's3://' + bucket_name + '/' + lic_name
        ret = {
            'statusCode': statusCode,
            'headers': { 'Content-Type': 'plain/text' },
            'body': lic_s3_path
        }
        logger.info('instance_id(%s) get return:\r\n%s' % (instance_id, ret))
        return ret
    except Exception as e:
        raise

