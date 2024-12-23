const cds = require('@sap/cds/lib')
const https = require('https');
const AbstractProvisioningService = require('./abstract-provisioning-service')
const LOG = cds.log('mtx'), DEBUG = cds.debug('mtx')
const { X509Certificate } = require('crypto')
const axiosInstance = require('axios').create()
axiosInstance.interceptors.response.use(response => response, require('../../lib/pruneAxiosErrors'))

module.exports = class SmsProvisioningService extends AbstractProvisioningService {

    async init() {
        this.on('UPDATE', 'tenant', this._create)
        this.on('READ', 'tenant', this._read)
        this.on('DELETE', 'tenant', this._delete)
        this.on('READ', 'dependencies', this._dependencies)
        this.on('upgrade', super._upgrade)
        this.on('getAppUrl', super._getAppUrl)
        await super.init()
    }

    async _create(context) {
        this._validateCertificate(context)

        const { subscriber = {} } = context.data
        const { app_tid: subscribedTenantId, subaccountSubdomain: subscribedSubdomain } = subscriber

        DEBUG?.(`Sms subscription payload: `, context.data)

        const internalSubscriptionPayload = {
            subscribedTenantId,
            subscribedSubdomain,
            ...context.data // technical data that remains the same + data that we do not care of
        }

        const result = await super._create(context, internalSubscriptionPayload)

        cds.context.http.res.set('content-type', 'application/json')
        // workaround for return value -> skip original key that is added by runtime otherwise and is not accepted by subscription-manager
        if (!result.message) cds.context.http.res.send( { applicationURL: result })
        else return result
    }

    async _delete(context) {
        this._validateCertificate(context)
        return super._delete(context)
    }

    async _dependencies(context) {
        this._validateCertificate(context)
        return super._dependencies(context)
    }

    async _read(context) {
        this._validateCertificate(context)
        return super._read(context)
    }

    _parseHeaders(headers) {
        const { prefer, status_callback } = headers ?? {}
        const { multitenancy, 'cds.xt.SmsProvisioningService': sps } = cds.env.requires
        const { subscription_manager_url } = multitenancy?.credentials ?? sps?.credentials ?? {}
        const callbackUrl = (status_callback && subscription_manager_url && new URL(status_callback, subscription_manager_url).toString())
        return {
            callbackUrl,
            isSync: !(prefer?.includes('respond-async') || callbackUrl)
        }
    }

    async _sendCallback(status, message, applicationUrl) {
        const originalRequest = cds.context?.http?.req
        const { callbackUrl } = this._parseHeaders(originalRequest?.headers)
        if (callbackUrl) {
          const payload = { status, message, applicationUrl }

          DEBUG?.(`send callback to ${callbackUrl}`)
          try {
              await this.sendResult(callbackUrl, payload, null, `Bearer ${await this._smsRegistryToken()}`)
          } catch (error) {
              LOG.error(error)
          }
        }
    }

    // REVISIT Repeated multiple times in CAP universe
    async _smsRegistryToken() {
        const { multitenancy, 'cds.xt.SmsProvisioningService': sps } = cds.env.requires
        const { clientid, clientsecret, certurl, url, certificate, key } = multitenancy?.credentials ?? sps?.credentials ?? {}
        const auth = certificate ? { maxRedirects: 0, httpsAgent: new https.Agent({ cert: certificate, key }) }
                                 : { auth: { username: clientid, password: clientsecret } }
        if (!clientid) {
            cds.error('No subscription-manager credentials available from the application environment.', { status: 401 })
        }

        try {
            const authUrl = `${certurl ?? url}/oauth/token`
            LOG.info(`getting subscription-manager auth token from ${authUrl}`)
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
                cds.error('Could not get subscription-manager token: token is empty', { status: 401 })
            }
            return access_token
        } catch (error) {
            cds.error('Could not get auth token for subscription-manager: ' + error.message, { status: 401 })
        }
    }

    _validateCertificate(req) {

        const CERTIFICATE_HEADER = '-----BEGIN CERTIFICATE-----'
        const header = cds.requires['cds.xt.SmsProvisioningService']?.clientCertificateHeader
        const certHeader = (header && req.headers?.[header]) ?? req.headers?.['X-Forwarded-Client-Cert'] ?? req.headers?.['x-forwarded-client-cert']
        if (!certHeader) return req.reject(401, `Missing certificate header: ${certHeader}`)

        // check for kyma header, see https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/headers#x-forwarded-client-cert
        const matchEnvoy = certHeader.match(/Cert="([^"]*)/);
        const certString = matchEnvoy ? decodeURIComponent(matchEnvoy[1]) : certHeader;

        let cert
        try {
            const encoding = certString.startsWith(CERTIFICATE_HEADER) ? 'utf-8' : 'base64'
            const buffer = Buffer.from(certString, encoding)
            cert = new X509Certificate(buffer)
        } catch {
            return req.reject(401, 'Invalid certificate')
        }

        const { callback_certificate_issuer, callback_certificate_subject } = cds.env.requires['cds.xt.SmsProvisioningService'].credentials ?? {}

        if (!callback_certificate_issuer || !callback_certificate_subject) return req.reject(401, 'No subscription-manager binding')

        const isIssuerValid = isValid(callback_certificate_issuer, cert.issuer)
        const isSubjectValid = isValid(callback_certificate_subject, cert.subject)

        function isValid(expected, fromCert) {
            return Object.entries(JSON.parse(expected)).every(([k, v]) => {
                if (v === '*') return true
                if (Array.isArray(v)) return v.some(v => fromCert.includes(`${k}=${v}`))
                else return fromCert.includes(`${k}=${v}`)
            })
        }

        if (!isIssuerValid || !isSubjectValid) return req.reject(403, 'Certificate check failed')
      }
}
