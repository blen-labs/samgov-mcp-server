# Terms of Service — SAM.gov Opportunities (by BLEN)

_Last updated: 2026-10-08_

## 1. Acceptance and scope

By accessing or using the BLEN-hosted **SAM.gov Opportunities** service at
`https://samgov.mcp.blenlabs.com/mcp` (the "Service", operated by BLEN, Inc.),
you agree to these terms. If you do not agree, do not use the Service. If you
use it on behalf of an organization, you represent that you are authorized
to accept these terms for that organization.

The underlying `samgov-mcp-server` software is separately licensed under
[Apache-2.0](../LICENSE). These hosted-service terms do not replace that
license or restrict rights it grants. Self-hosted deployments operate under
their operators' terms and policies.

## 2. Independent service and data source

The Service is an independent, read-only client for the
[SAM.gov public opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/).
BLEN is not affiliated with, sponsored by, or endorsed by the U.S. government,
the General Services Administration, or SAM.gov.

Third-party content remains subject to applicable rights and source notices.
These terms grant no rights to government seals, trademarks, or third-party
material beyond those otherwise available to you.

## 3. Accounts and organization keys

Access requires an invitation and an active organization membership. Use an
account you are authorized to use and protect its login credentials. Your
organization is responsible for identifying its administrators and members
and requesting access removal when appropriate.

An administrator supplies one SAM.gov API key for the organization. All
authorized members of that organization can use it for searches through the
Service. Use a system-account API key that your organization is authorized
to use for public opportunity searches and this hosted integration. Do not
enter an individual personal key for shared organization access.

You are responsible for following [SAM.gov's terms](https://sam.gov/about/terms-of-use),
account permissions, applicable usage limits, and key renewal requirements.
Bringing your own key does not waive those requirements. Supplying a key
authorizes BLEN to store it encrypted and use it to perform requests for
your authorized organization members. The Service does not need your
SAM.gov password.

Saving a key does not verify its type, permissions, expiration, or whether
searches will succeed. Replacing it affects the whole organization. Notify
BLEN and your organization administrator if you suspect unauthorized access.

## 4. Informational use and accuracy

The Service supports research and discovery. It does not provide legal or
procurement advice, determine eligibility or compliance, submit bids, or
represent government approval.

SAM.gov data can contain errors, omissions, or publication delays. Filters
can exclude relevant notices, and an AI assistant can summarize results
incorrectly. Verify the original notice, amendments, deadlines, attachments,
and agency instructions on SAM.gov before making a business decision or
submitting a response. Search results are not a guarantee of a complete or
current opportunity record.

## 5. Acceptable use

You agree not to:

- Bypass authentication, organization boundaries, rate limits, or other
  access controls.
- Use another person's account or another organization's key without
  authorization, or attempt to retrieve stored credentials.
- Submit requests intended to expose secrets, access host internals, modify
  government records, or cause excessive load.
- Put credentials, confidential records, controlled unclassified information,
  or sensitive personal information in search arguments. Supply the
  authorized organization API key only through the designated key-entry form.
- Use the Service unlawfully, infringe others' rights, or misrepresent its
  output as an official government determination.

We may limit, suspend, or revoke access to address violations, abuse,
security incidents, or threats to availability. Disabling access does not
automatically delete retained records; see the Privacy Policy.

## 6. Limits and availability

The Service exposes one tool, `get_sam_opportunities`, for public opportunity
searches. It does not execute user code, submit bids, publish notices, or
modify SAM.gov records. Descriptions, attachments, entities, exclusions, and
historical notice versions are outside the current tool's scope.

Service and upstream rate limits apply. Organization members share the
organization's key and relevant quotas. Limits may change, and upstream
providers may restrict or interrupt access independently of BLEN.

The Service is in preview. A successful login, saved key, health check, or
software release does not guarantee live SAM.gov search availability or
compatibility with every MCP client. See the current
[verification record](../docs/verification.md) for known limitations.
No service-level or support response-time guarantee is provided here.

## 7. Privacy

The [Privacy Policy](./privacy-policy.md) describes login information,
organization keys, search requests, provider disclosures, storage, cookies,
and retention. Google, SAM.gov, your MCP client, and self-hosted operators
have their own applicable policies and terms.

## 8. Warranty

The Service is provided **"as is"** and **"as available"**. To the maximum
extent permitted by law, BLEN disclaims warranties, including merchantability,
fitness for a particular purpose, and non-infringement. We do not guarantee
accuracy, uninterrupted availability, compatibility with every MCP client,
or continued free access. We may change or discontinue the hosted Service.

## 9. Liability

To the maximum extent permitted by law, BLEN, Inc. disclaims liability for
direct, indirect, incidental, special, or consequential damages arising
from use of or inability to use the Service. Nothing in these terms excludes
liability that cannot lawfully be excluded.

## 10. Changes

We may update these terms. Material changes will be noted in the repository
changelog at least 14 days before taking effect for the hosted Service.
If you do not agree to revised terms, stop using the Service.

## 11. Governing law

These terms are governed by the laws of Delaware, USA, subject to applicable
mandatory law.

## 12. Contact

Questions about these terms: **opensource@blencorp.com**. General support is
also available through [BLEN's contact page](https://www.blencorp.com/connect).
Report security vulnerabilities privately as described in
[SECURITY.md](../SECURITY.md).
