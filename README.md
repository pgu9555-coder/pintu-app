# Pintu

**A cross-platform collaboration tool for planning meetups, choosing destinations, and settling shared expenses.**

[Live Web Demo](https://pintu-app-nu.vercel.app/) · [WeChat Mini Program Guide](miniprogram-shell/README.md)

Pintu helps groups move from discussion to a shared decision. Friends can estimate a reference midpoint, propose and vote on destinations, make a random choice when preferences are unclear, and manage a shared ledger. The repository contains both a browser-based application and a native WeChat Mini Program backed by protected CloudBase services.

## Product highlights

- **Cross-platform rooms:** Join the same protected room from the web application or WeChat Mini Program with an eight-character invitation code.
- **Collaborative meetup planning:** Share starting locations, calculate a reference midpoint, add candidate destinations, vote, and let the room owner confirm the final choice.
- **Shared expense tracking:** Add, edit, and delete expenses; select payers and participants; review balances; and generate settlement recommendations using exact-cent arithmetic.
- **User-controlled identity:** WeChat users may add, replace, or remove a profile image and nickname, while cloud identity is derived from a trusted OpenID rather than client-supplied identifiers.
- **Resilient room history:** Authorized WeChat users can recover their rooms across devices through stable cursor-based pagination.
- **Secondary decision tools:** Use a local random spinner or destination picker without uploading their contents to a shared room.

## Platform capabilities

| Capability | Web | WeChat Mini Program | Cross-device synchronization |
|---|:---:|:---:|:---:|
| Reference midpoint and destination planning | Yes | Yes | Shared rooms |
| Candidate proposals, voting, and owner confirmation | Yes | Yes | Shared rooms |
| Multi-origin local planning and destination picker | Yes | Yes | Local only |
| Animated random spinner | Yes | Yes | Local only |
| Shared ledger and settlement recommendations | Yes | Yes | Shared rooms |
| Expense creation, editing, and deletion | Yes | Yes | Shared rooms |
| Membership, departure, and room dissolution | Yes | Yes | Shared rooms |
| Unified room-code entry | Yes | Yes | — |
| Native WeChat invitation cards | — | Yes | Invitation metadata only |
| WeChat profile and room history | — | Yes | Same WeChat identity |

The midpoint is a coordinate-based estimate, not a guarantee of equal travel time. Groups should evaluate roads, transit access, and accessibility before confirming a destination.

## Architecture

```text
Web application ───────────────┐
                              ├── roomGateway ── protected CloudBase data
Native WeChat Mini Program ───┘        │
                                      ├── authorization and membership epochs
                                      ├── room, voting, and ledger operations
                                      └── content-safety review

WeChat Mini Program ── mapGateway ── AMap Web Service
```

- `index.html` contains the deployed, dependency-free web application.
- `miniprogram-shell/` contains the native WeChat Mini Program; it does not rely on `web-view` or a third-party runtime.
- `cloudfunctions/roomGateway/` centralizes authorization, membership, content-safety checks, and synchronized room operations.
- `cloudfunctions/mapGateway/` proxies address suggestions and nearby-place searches so the AMap Web Service key remains server-side.

## Security and privacy design

- Clients cannot directly read or write the `rooms` collection; shared operations pass through `roomGateway`.
- Current online rooms use `schemaVersion: 5` and remain available until the owner explicitly dissolves them.
- Room codes function as invitation credentials and should be shared only with intended participants.
- Every rejoin creates a new `membershipEpoch`, preventing departed members and stale devices from continuing to modify protected room data.
- User-generated text displayed in the Mini Program passes through WeChat content-safety review. Web-created room content is reviewed before it is exposed to WeChat users.
- WeChat identity is derived from a trusted OpenID. Profile documents use non-readable identifiers, and clients cannot impersonate another member by submitting a nickname.
- Profile images remain in private CloudBase storage. Replacement and deletion use account-scoped paths plus retryable cleanup records; the storage bucket is never made publicly readable.
- Browser room history is stored locally. Mini Program room history is retrieved only for the authenticated WeChat identity and is not replaced with device cache after a network failure.

Legacy rooms retain their original platform rules and are upgraded only through a valid member flow; client parameters cannot force an untrusted room into the shared protocol.

## Testing

Run the repository checks with Node.js from the project root:

```bash
node scripts/test-room-gateway.cjs
node scripts/test-migrate-room-members.cjs
node scripts/test-index-html.cjs
node scripts/test-security-config.cjs
node scripts/test-miniprogram-native.cjs
node scripts/test-map-gateway.cjs
```

The checks cover gateway authorization and validation, membership migration, security configuration, web-app invariants, native Mini Program structure, and map-gateway behavior.

To inspect the Mini Program locally, import `miniprogram-shell/` into WeChat Developer Tools. Deployment configuration is documented in the [Mini Program guide](miniprogram-shell/README.md).

## Deployment

Pushes to `main` trigger GitHub Actions to:

1. Install and validate the CloudBase CLI.
2. Run the static and gateway test suites.
3. Prepare required collections and indexes, apply database security rules, and deploy `roomGateway`.
4. Preserve private avatar storage and account-scoped profile access.
5. Deploy the web application to CloudBase static hosting.

Address search requires an `AMAP_WEB_SERVICE_KEY` repository secret created for AMap Web Services. The workflow injects the key only into the temporary cloud-function deployment configuration; it is not committed to Git or shipped to either client. Without the secret, the workflow skips `mapGateway` while continuing to test and deploy the remaining application.

Mini Program releases are uploaded separately through WeChat Developer Tools or the WeChat CLI and must complete the WeChat review and publication process.

## Repository structure

```text
.
├── index.html
├── miniprogram-shell/
├── cloudfunctions/
│   ├── roomGateway/
│   └── mapGateway/
├── cloudbase-security-rules.json
├── cloudbase-function-security-rules.json
├── scripts/
└── .github/workflows/deploy-cloudbase.yml
```

## Known limitations

- Midpoint calculations use coordinates rather than real-time travel duration.
- A room code is a shared invitation credential; Pintu does not provide a public-room discovery system.
- Mini Program publication, content-safety availability, map-provider quotas, and CloudBase deployment depend on their respective external platforms.
- The live web demo and released Mini Program may not always represent the same deployment revision.

## License

[MIT](LICENSE)
