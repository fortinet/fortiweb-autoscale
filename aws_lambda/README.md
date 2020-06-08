# FortiWeb Autoscale for AWS Lambda

This folder contains source code for the FortiWeb Autoscale handler for the AWS Cloud Platform. A 'simple' autoscaling setup which takes advantage of the FortiWeb "Manager mode" feature to automate the synchronization of the autoscaling group configuration.

The entry point of this AWS Lambda function is **index.AutoscaleHandler**.

# Requirements
This function requires:
* FortiWeb 6.1.1 or higher
* An AWS account

## Environment Variables
This Lambda function has the following configurable environment variables.

| Variable Name | Type | Description |
| ------ | ------ | ------ |
| AUTO_SCALING_GROUP_NAME | Text | The autoscaling group name tied to this Lambda function.|
| CUSTOM_ID | Text | The custom string this Lambda function uses to look for resources such as DynamoDB tables.|
| UNIQUE_ID | Text | An AWS-regionally unique ID for solution resources such as DynamoDB name. This ID is used to look for specific solution resources.|

## IAM Policies
This AWS Lambda function requires the policies listed below.

### AWS Managed Policies
| Name | ARN |
| ------ | ------ |
| AmazonS3ReadOnlyAccess | arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess |
| AWSLambdaExecute | arn:aws:iam::aws:policy/AWSLambdaExecute |

### Custom Policies
| Action | Effect | Resource (in ARN format) |
| ------ | ------ | ------ |
| dynamodb:CreateTable, dynamodb:DescribeTable, dynamodb:Scan, dynamodb:Query, dynamodb:DeleteItem, dynamodb:GetItem, dynamodb:PutItem, dynamodb:UpdateItem | Allow | The DynamoDB tables created in the solution stack using CloudFormation templates.<br>ARN example: arn:aws:dynamodb:***AWS_REGION***:***AWS_ACCOUNT_ID***:table/***TABLE_NAME***|
| autoscaling:CompleteLifecycleAction, autoscaling:SetDesiredCapacity, autoscaling:SetInstanceProtection | Allow | The autoscaling group created in the solution stack using CloudFormation templates.<br>ARN example: arn:aws:autoscaling:***AWS_REGION***:***AWS_ACCOUNT_ID***:autoScalingGroup:\*:autoScalingGroupName/***AUTO_SCALING_GROUP_NAME***|
| autoscaling:DescribeAutoScalingInstances, ec2:DescribeInstances, ec2:DescribeVpcs, ec2:DescribeInstanceAttribute | Allow | \* |
| apigateway:GET | Allow | All API Gateways in a certain region.<br>ARN example: arn:aws:apigateway:***AWS_REGION***::\* |
| s3:GetObject | Allow | Contents of the **assets** folder for a particular solution in an S3 Bucket, as specified by the **STACK_ASSETS_S3_KEY_PREFIX**.<br>ARN example: arn:aws:s3:::***STACK_ASSETS_S3_BUCKET_NAME***/***STACK_ASSETS_S3_KEY_PREFIX***/assets/configset/* |

## Scope and Limits

This Lambda function is intended for use as a component of the FortiWeb Autoscale solution for AWS.
For more information, please refer to the project [README](https://github.com/fortinet/fortiweb-autoscale/blob/master/README.md).

# Support
Fortinet-provided scripts in this and other GitHub projects do not fall under the regular Fortinet technical support scope and are not supported by FortiCare Support Services.
For direct issues, please refer to the [Issues](https://github.com/fortinet/fortiweb-autoscale/issues) tab of this GitHub project.
For other questions related to this project, contact [github@fortinet.com](mailto:github@fortinet.com).

## License
[License](https://github.com/fortinet/fortiweb-autoscale/blob/master/LICENSE) © Fortinet Technologies. All rights reserved.
