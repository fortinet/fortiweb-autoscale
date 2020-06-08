# FortiWeb Autoscale
A collection of **Node.js** modules and cloud-specific templates which support basic autoscale functionality for groups of FortiWeb VM instances on various cloud platforms.

This project contains the code and templates for the **Amazon AWS** and **Microsoft Azure** autoscale deployments.

This project is organized in separate node modules:
 * [fortiweb-autoscale/core](core) contains the core logic and provides an interface which can be extended to deal with the differences in cloud platform APIs.
 * [fortiweb-autoscale/azure](azure) contains an implementation for the **Microsoft Azure** platform API and **Cosmos DB** storage backend.
 * [fortiweb-autoscale/aws](aws) contains an implementation for the **AWS SDK** platform API with a **Dynamo DB** storage backend.

The project also contains a deployment script which can generate packages for each cloud service's *serverless* implementation.

## Supported Platforms
This project supports autoscaling for the cloud platforms listed below. The version tag in parentheses refers to the autoscale module version included in this project.
  * Amazon AWS (1.0.0-beta)
  * Microsoft Azure (1.0.0-beta)

## Deployment Packages
To generate local deployment packages:

  1. Clone this project.
  2. Run `npm run build` at the project root directory.

Deployment packages as well as source code will be available in the **dist** directory.

| Package Name | Description |
| ------ | ------ |
| fortiweb-autoscale.zip | Source code for the entire project. |
| fortiweb-autoscale-aws-cloudformation.zip | Cloud Formation template. Use this to deploy the solution on the AWS platform.|
| fortiweb-autoscale-aws-lambda.zip | Source code for the FortiWeb Autoscale handler - AWS Lambda function.|
| fortiweb-autoscale-azure-funcapp.zip | Source code for the FortiWeb Autoscale handler - Azure function.|
| fortiweb-autoscale-azure-quickstart.zip | Azure template. Use this to deploy the solution on the Azure platform.|

Installation Guides is available from the Fortinet Document Library:
  * [ FortiWeb / Deploying auto scaling on AWS](https://docs.fortinet.com/vm/aws/fortiweb/)
  * [ FortiWeb / Deploying Auto Scaling on Microsoft Azure](https://docs.fortinet.com/vm/azure/fortiweb)

# Support
Fortinet-provided scripts in this and other GitHub projects do not fall under the regular Fortinet technical support scope and are not supported by FortiCare Support Services.
For direct issues, please refer to the [Issues](https://github.com/fortinet/fortiweb-autoscale/issues) tab of this GitHub project.
For other questions related to this project, contact [github@fortinet.com](mailto:github@fortinet.com).

## License
[License](https://github.com/fortinet/fortiweb-autoscale/blob/master/LICENSE) © Fortinet Technologies. All rights reserved.
