using { cds.xt.Extensions } from '../db/extensions';
using from './jobs-service';

@protocol: 'rest'
@requires: ['cds.ExtensionDeveloper', 'internal-user']
service cds.xt.ExtensibilityService @(path:'/-/cds/extensibility', impl:'@sap/cds-mtxs/srv/extensibility-service.js') {

  type ActivationLevel : cds.xt.Extensions:activated;
  type CSN : String; // REVISIT: should reuse cds.xt.CSN
  type CSN_OR_CDL: String;

  type FILE {
    name: String;
    content: LargeString;
  }

  action set(
    extension  : array of CSN_OR_CDL,
    resources  : array of FILE,
    tag        : cds.xt.Extensions:tag, // optional
    activate   : ActivationLevel, // default #database
    tenant     : String // optional, for internal-user only
  );

  @cds.persistence.skip
  entity Extensions {
    key ID    : String;
    @open csn : array of CSN_OR_CDL;
    i18n      : array of FILE;
    timestamp : Timestamp @cds.on.insert:$now @cds.on.update:$now;
  }
}

/*
 * PRIVATE APIs!!!
 */
extend service cds.xt.ExtensibilityService with @private {

  type TAR : LargeBinary;

  @requires: ['cds.ExtensionDeveloper']
  @private action pull() returns TAR;

  @requires: ['cds.ExtensionDeveloper']
  @private action push (
    extension : TAR,
    tag       : cds.xt.Extensions:tag,
    tenant    : String // optional, for internal-user only
  );
}

// Access to legacy content
extend service cds.xt.ExtensibilityService {

  @requires: ['cds.ExtensionDeveloper']
  @private action getMigratedProjects(
    tagRule: String,  // optional
    defaultTag: String, // optional
    tenant: String // optional
  ) returns LargeBinary;
}
