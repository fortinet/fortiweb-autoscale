#!/usr/bin/env python3
import os
from unittest.mock import Mock
from unittest.mock import patch
import validate_lambda


def get_default_rpt():
    rpt = {}
    rpt['FortiWebAsgCapacityBYOL'] = 2
    rpt['FortiWebAsgMinSizeOnDemand'] = 1
    rpt['FortiWebAsgDesiredCapacityOnDemand'] = 2
    rpt['FortiWebAsgMaxSizeOnDemand'] = 4
    rpt['FortiWebAsgScaleInThreshold'] = 25
    rpt['FortiWebAsgScaleOutThreshold'] = 80
    rpt['FortiWebVersionShow'] = 'LATEST'
    rpt['AddNewElasticIPorNot'] = 'no'
    rpt['FortiWebElasticIP'] = '1.1.1.1'
    return rpt

def get_default_event():
    event = {}
    event['ResourceProperties'] = None
    event['RequestType'] = 'Create'
    event['ResponseURL'] = 'http://127.0.0.1:3000'
    event['StackId'] = 'fake_StackId'
    event['RequestId'] = 'fake_RequestId'
    event['LogicalResourceId'] = 'fake_LogicalResourceId'
    return event

def get_default_context():
    context = Mock()
    context.get_remaining_time_in_millis.return_value = 10*1000
    context.log_group_name = 'fake_log_group_name'
    context.log_stream_name = 'fake_log_stream_name'
    return context

def mock_requests_put(*args, **kvargs):
    print('hello mock requests put')
    print(args, kvargs)
    mock = Mock()
    mock.reason = 'no error'
    return mock

@patch('validate_lambda.requests')
def test_byol_cnt(mock_requests):
    print('Test: BYOL Count should >= 0')
    mock_requests.put = mock_requests_put
    event = get_default_event()
    context = get_default_context()
    rpt = get_default_rpt()
    event['ResourceProperties'] = rpt
    rpt['FortiWebAsgCapacityBYOL'] = -1
    ret = validate_lambda.handler(event, context)
    print()


if '__main__' == __name__:
    test_byol_cnt()


