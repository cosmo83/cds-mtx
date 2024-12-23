using from '../jobs-service';

@protocol: 'rest'
@(requires: ['cds.Subscriber', 'mtcallback', 'internal-user'])
@(path:'/-/cds/saas-provisioning')
service cds.xt.SaasProvisioningService @(impl:'@sap/cds-mtxs/srv/cf/saas-provisioning-service.js') {

    @open
    @cds.persistence.skip
    entity tenant {
        key subscribedTenantId : String @assert.format: '^[^*]+$';
            subscribedSubaccountId : String(36);
            subscribedSubdomain : String(256);
            subscriptionAppName : String(256); // name of main subscribed application
            eventType: String(64); // "CREATE/UPDATE", indicates if called for new subscription (CREATE) or dependencies update (UPDATE)
    }

    function dependencies() returns array of { xsappname: String };
}

/* Multitenancy */
extend service cds.xt.SaasProvisioningService with {
    @open type UpgradeOptions {}
    @open type UpgradeResults {}

    action upgrade(tenants: Array of String, options: UpgradeOptions) returns UpgradeResults;

    // internal API - not so nice to model the request as parameter :( -> pass only headers?
    function getAppUrl(@open subscriptionPayload: {}, @open subscriptionHeaders: {}) returns String;
}
