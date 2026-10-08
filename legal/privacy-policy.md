# Privacy Policy — SAM.gov Opportunities (by BLEN)

_Last updated: 2026-10-08_

This policy describes how **SAM.gov Opportunities**, powered by
`samgov-mcp-server` (the "Service", operated by BLEN, Inc.), handles information
when accessed from Gemini Enterprise or another MCP client.

The BLEN-hosted endpoint is `https://samgov.mcp.blenlabs.com/mcp`. It provides
authenticated, read-only searches of public SAM.gov contract opportunities.
Access requires an organization invitation. Each organization supplies its
own SAM.gov API key, which is used by its authorized members.

## Information we receive

- **Sign-in information:** when you choose Google sign-in, we request your
  account identifier, email address, email verification status, name, and
  profile information, which can include a profile picture. The requested
  Google scopes are `openid`, `email`, and `profile`; the Service does not
  request access to Gmail, Drive, Calendar, or your Google password.
- **Organization and access records:** organization names, invited email
  addresses, membership roles, account identifiers, registered MCP clients,
  and the permissions granted to those clients.
- **Authentication records:** login sessions, OAuth grants and tokens,
  account recovery records, and authentication-related network metadata such
  as IP addresses and user agents. If an operator sets up password login,
  Better Auth stores a password hash rather than the plaintext password.
- **Organization API keys:** an administrator supplies the organization's
  SAM.gov system-account API key through the key-entry form. We do not need
  the organization's SAM.gov password. The Service currently stores one key
  per organization, not a separate personal key for each member.
- **Search requests and results:** tool arguments such as title keywords,
  dates, agencies, locations, NAICS codes, and notice identifiers, plus the
  public opportunity data returned for those requests. The connector receives
  tool requests, not an automatic copy of your entire conversation. Your MCP
  client determines what it sends.
- **Network and support information:** hosting infrastructure processes
  connection metadata and request headers. We also receive information you
  choose to provide when contacting BLEN for support.

Do not include passwords, API keys, confidential records, or sensitive
personal information in search arguments or support messages. Enter the
organization's API key only in the designated key-entry form.

## How we use information

We use this information to sign users in, check organization access, select
the correct organization key, perform requested searches, protect the
Service from abuse, diagnose failures, and respond to support requests.

We do not sell personal information, build advertising profiles from
connector usage, or train AI models on submitted queries or results. This
server does not run an AI model. These statements do not govern the separate
AI assistant or MCP client you choose to use.

## Information sent to other services

- **Google:** Google handles Google sign-in and receives the authentication
  request. Better Auth is the authentication software running within this
  Service. Google processes sign-in information under its own policies.
- **SAM.gov:** the Service sends the search filters and the organization's
  API key to the public opportunities API at `api.sam.gov`. SAM.gov requires
  the key in the API request's query string. The Service does not intentionally
  forward your Google tokens, inbound authorization header, or user IP address
  to SAM.gov. Outbound requests use the hosting provider's network address.
- **Your MCP client:** search results return to the connected assistant.
  The organization API key is not included in MCP tool arguments or results.
  The client receives its own OAuth credentials for access to this Service;
  these are separate from the SAM.gov key. Client-side storage, conversation
  history, and AI processing are governed by the client's policies.
- **Infrastructure providers:** Railway hosts the application and PostgreSQL
  database. Cloudflare provides DNS for the custom domain. Infrastructure
  providers process data needed to deliver their services under their
  applicable policies and deployment settings.

We may disclose information where required by law or necessary to address
abuse, investigate security incidents, or protect the Service.

## Storage, cookies, and retention

- **Persistent database records:** PostgreSQL stores organizations,
  invitations, memberships, login and account records, organization keys,
  registered clients, OAuth records, and rate-limit counters. Organization
  keys and OAuth broker payloads are encrypted at the application layer.
  Better Auth also encrypts stored provider OAuth tokens. This does not mean
  every database field is encrypted by the application: identity, membership,
  and some authentication metadata remain readable to database administrators.
- **Sessions and cookies:** sign-in and authorization pages use cookies
  necessary for login, session continuity, and request protection. The
  application does not embed advertising cookies or browser analytics
  beacons. Blocking required cookies can prevent sign-in.
- **Search content:** the application has no feature that saves conversation
  histories, search arguments, or search results to its database. It does
  not persist a search-result cache. Requests and results are processed in
  memory. This is not a guarantee that infrastructure or diagnostic logs
  exclude every request fragment.
- **Expiry and deletion:** expired OAuth broker records and rate-limit
  windows are periodically cleaned up. Session or token expiry is not a
  promise that all associated account data has been deleted. Disabling an
  organization or member blocks access but retains their records. Replacing
  a key updates the active database record; older copies can remain in
  backups. Disconnecting an assistant does not automatically delete the
  organization's key, account, or membership records.
- **Logs, backups, and support records:** the application emits operational
  messages and suppresses raw upstream errors that could reveal keys.
  Infrastructure may retain additional logs and backups. Retention depends
  on provider settings and operational or legal needs; this policy does not
  promise a fixed deletion period. Contact BLEN about retention or deletion
  of particular records.

## Your controls

Disconnect the connector in your MCP client to stop using that connection.
Your organization administrator can ask the service operator to revoke
membership or organization access. Administrators can replace the saved
SAM.gov key through a fresh authorization flow. Removing access in Google
does not itself delete the organization's SAM.gov key or every previously
issued connector grant.

For access, correction, deletion, or privacy requests concerning information
held by BLEN, contact **opensource@blencorp.com**. Identify the organization
and account involved, but do not send credentials. We may need to verify
your identity and authority before acting. Consult your MCP client's own
controls for its conversation history and retained data.

## Security and limits

The hosted Service uses HTTPS, invitation and membership checks, OAuth with
PKCE, request protections, rate limits, and encrypted organization keys.
Only authorized administrators can replace an organization's key. Members
can use it through the Service without retrieving its value.

Encryption does not prevent the service operator from accessing data:
operators control the host and encryption keys, and the running application
must decrypt the SAM.gov key to make requests. No safeguard guarantees
protection against every incident. Report vulnerabilities privately using
the process in [SECURITY.md](../SECURITY.md).

## Self-hosted deployments

Operators who self-host this software control their infrastructure,
authentication, credentials, logs, backups, and retention. Their privacy
policies apply to their services. Contact that operator for requests about
a self-hosted deployment.

## Changes and contact

Updates will be published here with a revised date. Privacy questions and
requests: **opensource@blencorp.com**. See also the
[Terms of Service](./terms.md) and [BLEN's contact page](https://www.blencorp.com/connect).
