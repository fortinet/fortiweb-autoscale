import json,logging,threading,boto3
from botocore.vendored import requests
import re
import urllib3
CFN_SUCCESS = "SUCCESS"
CFN_FAILED = "FAILED"

g_return_error = True

def cfn_send(evt, context, responseStatus, respData, reason=''):
    respUrl = evt['ResponseURL']
    print(respUrl)
    respBody = {}
    respBody['Status'] = responseStatus
    respBody['Reason'] = reason + '\nSee the details in CloudWatch:' + context.log_group_name + ',' + context.log_stream_name
    respBody['PhysicalResourceId'] = context.log_stream_name
    respBody['StackId'] = evt['StackId']
    respBody['RequestId'] = evt['RequestId']
    respBody['LogicalResourceId'] = evt['LogicalResourceId']
    respBody['NoEcho'] = None
    respBody['Data'] = respData

    json_respBody = json.dumps(respBody)
    print("Response body:\n" + json_respBody)
    headers = {'content-type' : '', 'content-length' : str(len(json_respBody)) }
    try:
        http = urllib3.PoolManager()
        response = http.request('PUT', respUrl, headers=headers, body=json_respBody)
        #response = requests.put(respUrl,data=json_respBody,headers=head    ers)
        print("Status code: " + response.status)
    except Exception as e:
        print("failed executing requests.put(..): " + str(e))

def validate_parameters(byol_cnt, asgdc, asgmin, asgmax, scaleInTh, scaleOutTh, eipOpt, eip):
    global g_return_error
    message = ''
    if asgmin < 0 or asgmax < 0 or asgdc < 0:
        message = message + '(FortiWebAsgMinSizeOnDemand:%d, FortiWebAsgDesiredCapacityOnDemand:%d, FortiWebAsgMaxSizeOnDemand:%d) each should be not less than 0.\n' % (asgmin, asgdc, asgmax)
    if byol_cnt < 0:
        message = message + 'FortiWebAsgCapacityBYOL(%d) should be not less than 0.\n' % (byol_cnt)
    if (asgmin > asgmax):
        message = message + 'FortiWebAsgMinSizeOnDemand(%d) should be less than or equal to FortiWebAsgMaxSizeOnDemand(%d).\n' % (asgmin, asgmax)
    if (asgdc < asgmin):
        message = message + 'FortiWebAsgDesiredCapacityOnDemand(%d) should be bigger than or equal to FortiWebAsgMinSizeOnDemand(%d).\n' % (asgdc, asgmin)
    if (asgdc > asgmax):
        message = message + 'FortiWebAsgDesiredCapacityOnDemand(%d) should be less than or equal to FortiWebAsgMaxSizeOnDemand(%d).\n' % (asgdc, asgmax)
    if byol_cnt + asgmax > 16:
        message = message + 'Sum of FortiWebAsgCapacityBYOL and FortiWebAsgMaxSizeOnDemand should not bigger than 16.\n'
    if (scaleInTh >= scaleOutTh):
        message = message + 'FortiWebAsgScaleInThreshold(%d) should be less than FortiWebAsgScaleOutThreshold(%d).\n' % (scaleInTh, scaleOutTh)
    if ('no' == eipOpt):
        if len(eip) < 1:
            message = message + 'FortiWebElasticIP(%s) should not be empty.\n' % (eip)
        ip_expr='^(([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]){1}$'
        if None == re.match(ip_expr, eip):
            message = message + 'FortiWebElasticIP(%s) should be valid IP address when use existing Elastic IP.\n' % (eip)
    if ('no' != eipOpt):
        if len(eip) < 1:
            message = message + 'FortiWebElasticIP Name(%s) should be valid tag value when creating a new Elastic IP.\n' % (eip)
    if (0 != len(message)):
        print('Parameter(s) not valid, see blow:')
        print('%s' % (message))
    else:
        g_return_error = False
        print('parameter valid')
        message = 'no error'
    return message

def delete_objects():
    print("nothing to do")

def timeout(event, context):
    logging.error('Time out, failure response to CloudFormation')
    cfn_send(event, context, CFN_FAILED, {}, 'fwb labmda timeout')

def handler(event, context):
    global g_return_error
    #initiallize it, because global values may keep last run assigned value
    g_return_error = True
    # make sure we send a failure to CloudFormation if the function is going to timeout
    timer = threading.Timer((context.get_remaining_time_in_millis() / 1000.00) - 0.5, timeout, args=[event, context])
    timer.start()
    print('event: %s' % json.dumps(event))
    print('context:%s' % (str(context)))
    status = CFN_SUCCESS
    respData = {}
    err_msg = 'no error'
    rpt = event['ResourceProperties']
    try:
        byol_cnt = rpt['FortiWebAsgCapacityBYOL']
        asgdc = rpt['FortiWebAsgDesiredCapacityOnDemand']
        asgmin = rpt['FortiWebAsgMinSizeOnDemand']
        asgmax = rpt['FortiWebAsgMaxSizeOnDemand']
        scaleInTh = rpt['FortiWebAsgScaleInThreshold']
        scaleOutTh = rpt['FortiWebAsgScaleOutThreshold']
        FortiWebVersionInternal = rpt['FortiWebVersionShow']
        eipOpt = rpt['AddNewElasticIPorNot']
        eip = rpt['FortiWebElasticIP']
        respData['FortiWebVersionInternal'] = FortiWebVersionInternal.replace('.', '')
        if event['RequestType'] == 'Delete':
            delete_objects()
            g_return_error = False
        else:
            err_msg = validate_parameters(int(byol_cnt), int(asgdc), int(asgmin), int(asgmax),
                            int(scaleInTh), int(scaleOutTh),
                            eipOpt, eip)
    except Exception as e:
        logging.error('Exception: %s' % (str(e)), exc_info=True)
        err_msg = 'exception: %s' % (str(e))
        status = CFN_FAILED
    finally:
        timer.cancel()
        if True == g_return_error:
            status = CFN_FAILED
        cfn_send(event, context, status, respData, err_msg)

class fake_ctx(object):
    def __init__(self):
        pass
    def get_remaining_time_in_millis(self):
        return 100000

if __name__ == "__main__":
    print('hello')
    rpt = {}
    rpt['FortiWebAsgCapacityBYOL'] = 0
    rpt['FortiWebAsgMinSizeOnDemand'] = 1
    rpt['FortiWebAsgDesiredCapacityOnDemand'] = 1
    rpt['FortiWebAsgMaxSizeOnDemand'] = 1
    rpt['FortiWebAsgScaleInThreshold'] = 25
    rpt['FortiWebAsgScaleOutThreshold'] = 80
    rpt['FortiWebVersionShow'] = 'LATEST'
    rpt['AddNewElasticIPorNot'] = 'no'
    rpt['FortiWebElasticIP'] = '1.1.1.1'
    event = {}
    event['ResourceProperties'] = rpt
    event['RequestType'] = 'Create'
    ctx = fake_ctx()
    handler(event, ctx)

