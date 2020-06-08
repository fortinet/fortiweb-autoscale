# FortiWeb Autoscale - Core

`fortiweb-autoscale/core` contains the core logic used to handle autoscaling groups of FortiWeb VM instances in various cloud platforms.

The design metaphor for `fortiweb-autoscale/core` is an API sandwich with cloud-specific layers on the outside and core functionality in the middle. Leveraging this API requires extending the following classes:

* `AutoscaleHandler` is a _base_ class which handles the core logic. This class should be extended to handle events invoked by each cloud platform.

The reference implementation is `multi-cloud-autoscale/aws`:

 * `AwsAutoscaleHandler` handles the lambda entry event and calls the base class methods to handle the core logic
 * `AwsPlatform` contains methods called by `AutoscaleHandler` to actually call into the aws api.


For more information, please refer to the project [README](https://github.com/fortinet/fortiweb-autoscale/blob/master/README.md).

# Support
Fortinet-provided scripts in this and other GitHub projects do not fall under the regular Fortinet technical support scope and are not supported by FortiCare Support Services.
For direct issues, please refer to the [Issues](https://github.com/fortinet/fortiweb-autoscale/issues) tab of this GitHub project.
For other questions related to this project, contact [github@fortinet.com](mailto:github@fortinet.com).

## License
[License](https://github.com/fortinet/fortiweb-autoscale/blob/master/LICENSE) © Fortinet Technologies. All rights reserved.
