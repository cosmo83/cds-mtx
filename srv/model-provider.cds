context cds.xt { // IMPORTANT: we don't use namespaces to avoid issues with cds.db default namespace

  @open type CSN {};
  type TAR : LargeBinary;
  type XML : LargeString;
  type Locale : String;
  type TenantID : String;
  type CSNConsumer : String enum { nodejs; java; };
  @open type I18N {}


  /**
   * Used by CAP runtimes to retrieve tenant-specific variants of
   * deployed models used to serve requests.
   */
  @protocol: 'rest'
  @requires: [ 'internal-user' ] //> we check that ourselves programmatically in production only
  service ModelProviderService @(path:'/-/cds/model-provider', impl:'@sap/cds-mtxs/srv/model-provider.js') {

    action getCsn(
      tenant    : TenantID,
      @cds.validate: false
      toggles   : array of String,
      for       : CSNConsumer @cds.java.name: 'runtime',
      flavor    : String enum { parsed ; xtended ; inferred },
      base      : Boolean,
      activated : Boolean
    ) returns CSN;

    action getExtCsn(
      tenant  : TenantID,
      @cds.validate: false
      toggles : array of String,
      for     : CSNConsumer @cds.java.name: 'runtime',
    ) returns CSN;

    action getExtResources(
      tenant    : String
    ) returns TAR;

    action getEdmx(
      tenant  : TenantID,
      @cds.validate: false
      toggles : array of String,
      service : String,
      model   : CSN, // internal
      locale  : Locale,
      flavor  : String enum { v2; v4; w4; x4 },
      for     : CSNConsumer @cds.java.name: 'runtime',
    ) returns XML;

    action getI18n(
      tenant  : TenantID,
      @cds.validate: false
      toggles : array of String,
      locale  : Locale
    ) returns I18N;

    action isExtended(
      tenant  : TenantID,
    ) returns Boolean;

    action getExtensions(
      tenant  : TenantID,
    ) returns CSN;

    action getResources () returns TAR;

    // -------------------------------
    // Later, possibly:
    // function GET csn(...)
    // function GET edmx(...)
    // function GET extended(...)
    // function GET resources(...)
  }

}
