const cds = require('@sap/cds/lib')
const https = require('https');
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')
const axiosInstance = require('axios').create()
axiosInstance.interceptors.response.use(response => response, require('../../lib/pruneAxiosErrors'))

module.exports = class SaasProvisioningService extends require('./abstract-provisioning-service') {

    async init() {
        this.on('UPDATE', 'tenant', this._create)
        this.on('READ', 'tenant', super._read)
        this.on('DELETE', 'tenant', super._delete)
        this.on('getAppUrl', super._getAppUrl)
        this.on('dependencies', super._dependencies)
        this.on('upgrade', super._upgrade)
        await super.init()
    }

    async _create(context) {
        if (context.data.eventType === 'UPDATE' && cds.requires['cds.xt.SaasProvisioningService']?.alwaysUpgradeModel === false) return
        return super._create(context, context.data)
    }

    _parseHeaders(headers) {
      const { prefer, status_callback, mtx_status_callback } = headers ?? {}
      const { multitenancy, 'cds.xt.SaasProvisioningService': sps } = cds.env.requires
      const { saas_registry_url } = multitenancy?.credentials ?? sps?.credentials ?? {}
      const callbackUrl = mtx_status_callback ?? (status_callback && saas_registry_url && new URL(status_callback, saas_registry_url).toString())
      return {
          callbackUrl,
          isCustomCallback: !!mtx_status_callback,
          saasCallbackUrlPath: status_callback,
          isSync: !(prefer?.includes('respond-async') || callbackUrl)
      }
    }

    async _sendCallback(status, message, subscriptionUrl) {
        const originalRequest = cds.context?.http?.req
        const { isSync, isCustomCallback, saasCallbackUrlPath, callbackUrl } = this._parseHeaders(originalRequest?.headers)
        if (!isSync && callbackUrl) {
          const tenant = this._getSubscribedTenant(originalRequest.body)
          const payload =  { status, message, subscriptionUrl }

          // additional payload for internal callback (java)
          let customPayload
          if (isCustomCallback) {
              customPayload = {
                  saasRequestPayload: originalRequest.body,
                  saasCallbackUrl: saasCallbackUrlPath,
                  tenant
              }
          }
          DEBUG?.(`send callback to ${callbackUrl}`)
          try {
            const authHeader = isCustomCallback ? originalRequest.headers.authorization : `Bearer ${await this._saasRegistryToken()}`
            await this.sendResult(callbackUrl, payload, customPayload, authHeader)
          } catch (error) {
              LOG.error(error)
          }
        }
    }

    async _saasRegistryToken() {
      const { multitenancy, 'cds.xt.SaasProvisioningService': sps } = cds.env.requires
      const { clientid, clientsecret, certurl, url, certificate, key } = multitenancy?.credentials ?? sps?.credentials ?? {}
      const auth = certificate ? { maxRedirects: 0, httpsAgent: new https.Agent({ cert: certificate, key }) }
                               : { auth: { username: clientid, password: clientsecret } }
      if (!clientid) {
          cds.error('No saas-registry credentials available from the application environment.', { status: 401 })
      }

      try {
          const authUrl = `${certurl ?? url}/oauth/token`
          LOG.info(`getting saas-registry auth token from ${authUrl}`)
          const { data: { access_token } } = await axiosInstance(authUrl, {
              method: 'POST',
              ...auth,
              params: {
                  grant_type: 'client_credentials',
                  response_type: 'token',
                  client_id: clientid
              }
          })
          if (!access_token) {
              cds.error('Could not get saas-registry token: token is empty', { status: 401 })
          }
          return access_token
      } catch (error) {
          cds.error('Could not get auth token for saas-registry: ' + error.message, { status: 401 })
      }
  }
}
