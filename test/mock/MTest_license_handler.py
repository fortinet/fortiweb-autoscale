#!/usr/bin/env python3
import os
from unittest.mock import Mock
from unittest.mock import patch
import handler

def describe_auto_scaling_groups(*args, **kwargs):
    return {
        'AutoScalingGroups': [{
            'Instances':[
                {'InstanceId': 'i-fakeid1'},
                {'InstanceId': 'i-fakeid2'}
            ]
        }]
    }

def try2_update_item(**kwargs):
    assert(kwargs['TableName'] == 'fake-CUSTOM_ID-FortiWebLic-fake-UNIQUE_ID')
    lic_name = kwargs['ExpressionAttributeValues'][':lic_name']['S']
    if 'lic2.lic' != lic_name:
        raise handler.botocore.exceptions.ClientError({'Error':{'Code': 'ConditionalCheckFailedException'}}, {})

def update_item_condi_exception(**kwargs):
    raise handler.botocore.exceptions.ClientError({'Error':{'Code': 'ConditionalCheckFailedException'}}, {})

@patch('handler.boto3')
@patch('handler.GetLicenseFileName')
def test_get_exists_lic(mock_GetLicenseFileName, mock_boto3):
    print('Test: license already assigned，just return license')
    mock_GetLicenseFileName.return_value = ['lic1.lic', 'lic2.lic']
    mock_boto3_client = Mock()
    mock_boto3.client.return_value = mock_boto3_client
    mock_boto3_client.describe_auto_scaling_groups = describe_auto_scaling_groups
    lic_name = 'licX.lic'
    mock_boto3_client.get_item.return_value = {
        'Item': {
            'inst_lic_pair': {
                "SS": [
                    'i-fakeid1',
                    'i-fakeid1'+handler.MAGIC_CONCATENATOR+'licX.lic',
                    'i-fakeid2',
                    'i-fakeid2'+handler.MAGIC_CONCATENATOR+'lic2.lic',
                    'lic1.lic',
                    'licX.lic'
                ]
            }
        }
    }
    ret = handler.lambda_handler(event, context)
    assert(lic_name in ret['body'])
    print()

@patch('handler.boto3')
@patch('handler.GetLicenseFileName')
def test_alloc_lic_try1(mock_GetLicenseFileName, mock_boto3):
    print('Test: new request for license，succed in first request')
    mock_GetLicenseFileName.return_value = ['lic1.lic', 'lic2.lic']
    mock_boto3_client = Mock()
    mock_boto3.client.return_value = mock_boto3_client
    mock_boto3_client.describe_auto_scaling_groups = describe_auto_scaling_groups
    mock_boto3_client.get_item.return_value = {}
    ret = handler.lambda_handler(event, context)
    assert('lic1.lic' in ret['body'])
    print()

@patch('handler.boto3')
@patch('handler.GetLicenseFileName')
def test_alloc_lic_try2(mock_GetLicenseFileName, mock_boto3):
    print('Test: new request for license，failed at first time, succed in second request')
    mock_GetLicenseFileName.return_value = ['lic1.lic', 'lic2.lic']
    mock_boto3_client = Mock()
    mock_boto3.client.return_value = mock_boto3_client
    mock_boto3_client.describe_auto_scaling_groups = describe_auto_scaling_groups
    mock_boto3_client.get_item.return_value = {}
    mock_boto3_client.update_item = try2_update_item
    ret = handler.lambda_handler(event, context)
    assert('lic2.lic' in ret['body'])
    print()

@patch('handler.boto3')
@patch('handler.GetLicenseFileName')
def test_no_lic(mock_GetLicenseFileName, mock_boto3):
    print('Test: no license，should return 404')
    mock_GetLicenseFileName.return_value = []
    mock_boto3_client = Mock()
    mock_boto3.client.return_value = mock_boto3_client
    mock_boto3_client.describe_auto_scaling_groups = describe_auto_scaling_groups
    mock_boto3_client.get_item.return_value = {}
    ret = handler.lambda_handler(event, context)
    assert(404 == ret['statusCode'])
    print()

@patch('handler.boto3')
@patch('handler.GetLicenseFileName')
def test_no_enough_lic(mock_GetLicenseFileName, mock_boto3):
    print('Test: no enough license，should return 404')
    mock_GetLicenseFileName.return_value = []
    mock_boto3_client = Mock()
    mock_boto3.client.return_value = mock_boto3_client
    mock_boto3_client.describe_auto_scaling_groups = describe_auto_scaling_groups
    mock_boto3_client.get_item.return_value = {}
    mock_boto3_client.update_item = update_item_condi_exception
    ret = handler.lambda_handler(event, context)
    assert(404 == ret['statusCode'])
    print()


if '__main__' == __name__:
    os.environ['BYOL_ASG_NAME'] = 'fake-BYOL_ASG_NAME'
    os.environ['S3Bucket'] = 'fake-S3Bucket'
    os.environ['S3Prefix'] = 'fake-S3Prefix'
    os.environ['CUSTOM_ID'] = 'fake-CUSTOM_ID'
    os.environ['UNIQUE_ID'] = 'fake-UNIQUE_ID'
    event = {}
    event['isBase64Encoded'] = False
    event['body'] = '{"instance": "i-fakeid1"}'
    context = {}
    test_get_exists_lic()
    test_alloc_lic_try1()
    test_alloc_lic_try2()
    test_no_lic()
    test_no_enough_lic()


