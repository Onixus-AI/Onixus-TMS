# Thompson's Mortuary Services — supervised onboarding

## Access path
Veltra → Business OS → Onixus TMS → Mortuary. Veltra and TMS currently have separate Supabase Auth projects. A shared email does not make them a single sign-on session. Do not copy credentials or tokens between them.

An empty TMS organization and pending owner invitation have been reserved for the owner email supplied by the operator. No invitation email was sent and no active membership was created by this setup. The existing TMS `/me` flow accepts the invitation after verified sign-in. No transport profile, operational approval, prices, fleet or case records were invented.

Veltra has a Google sign-in implementation, but its auth settings reported Google disabled on 2026-10-22. Enable the Google provider using an authorized Google OAuth client with callback `https://cohmkgctiqcedkuisbqh.supabase.co/auth/v1/callback`, and verify the approved Veltra return origins. Do not send credentials in chat or commit them. If Google login is desired directly in TMS, its separate auth project needs its own reviewed provider setup.

## Required before real work
- Owner verifies their account and confirms organization access.
- Staff emails, roles and driver mappings.
- Removal vehicles/hearses, identifiers and availability.
- Exact services and approved service/mileage/additional rates.
- Dispatch/escalation phone, service area, partner coverage.
- Restricted operating procedure reference and all six owner review checks.
- Hosted staging migration, real private document upload/download and authenticated multi-role rehearsal.

## Rehearsal acceptance
Use fictional names/references and no real decedent documents.
1. Intake domestic case; create a restricted record and configured required documents.
2. Upload → confirm → review each document. Verify another organization and unauthorized dispatcher cannot download.
3. Create and assign a ground leg. Verify overlapping assignments fail. Move case to ready only after checklist/onboarding gates pass.
4. Assigned driver starts leg, records identity check and pickup acknowledgment, marks in custody. Record a fresh identity check and receiving-party transfer before delivery. Close after all legs delivered and incidents resolved.
5. Draft/edit/issue quote, record acceptance reference, issue invoice. Verify payment remains NOT_VERIFIED. No email or charge occurs.
6. Repeat international case with sourced requirements, review dates, receiving party, carrier references and milestones. Verify incomplete/stale requirements block staff release and an owner records approval. This records an operational decision, not legal clearance or a carrier booking.

## Evidence boundaries
API tests rehearse domestic and international lifecycles with the real Express routes and a constrained in-memory store. Embedded PostgreSQL applies migration 015 and the SQL assertions; it is not a real Supabase Storage rehearsal or a multi-session PostgreSQL race test. UI review uses clearly marked fictional data. Hosted acceptance and actual client login remain open until external setup is available.
