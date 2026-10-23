# Pintu Native WeChat Mini Program

This directory contains Pintu's native WeChat Mini Program. It does not use `web-view`, browser DOM APIs, or a third-party runtime.

## Import and configuration

1. Import this `miniprogram-shell/` directory into WeChat Developer Tools.
2. Use AppID `wxe1fe19432c29e3cd`.
3. Connect the project to CloudBase environment `pintu-prod-d1grnmzg0f6778ea6` (Shanghai).
4. Confirm that the environment is linked to this existing Mini Program and that `roomGateway` and `mapGateway` are deployed. The native app calls CloudBase directly; it does not embed the temporary website or require a purchased domain for those calls.

## Core workflows

- **Unified room entry:** Enter an eight-character code on the home screen. The client identifies the room type and opens the appropriate meetup or ledger join flow.
- **Native invitations:** Meetup and ledger rooms support WeChat invitation cards. Cards contain only the room code and room type—not addresses, expenses, nicknames, or internal document identifiers. Recipients must confirm their name and required consent before joining.
- **Trusted identity:** Cloud functions identify the WeChat account through a trusted OpenID. Users may choose, replace, or remove a profile image and nickname, and can recover authorized rooms across devices under the same WeChat identity.
- **Meetup planning:** Participants may plan locally with multiple starting points or contribute their locations from separate devices. A shared room supports midpoint estimation, candidate destinations, voting, owner confirmation, and sequential destination selection.
- **Shared ledger:** Local and cloud rooms support members, expense creation and editing, payer and participant selection, balances, and settlement recommendations. For up to ten people with non-zero balances, the solver minimizes the number of transfers; larger groups receive a valid settlement plan.
- **Room lifecycle:** Owners may dissolve rooms and other members may leave. Online rooms currently remain active until they are dissolved.
- **Local spinner:** The spinner completes its visible animation before revealing a result. Entries and outcomes remain on the device and are not synchronized.
- **Portable backup:** Home → 备份与迁移 exports local books and previously downloaded shared snapshots to the same JSON format as the web app. The shared snapshot cache retains at most 20 recently changed books / 5 MB; unchanged polling does not rewrite storage. Distinct local and shared versions are retained separately in the export. Importing creates independent local books, without restoring cloud identities or access rights. Import is validated as one batch before storage is changed. Up to 100 books / 5 MB are supported.
- **Visual parity:** The native pages use the web app's warm ivory and green palette, shared font stack, and a maximum 480 px content column. Midpoint results include a native map, category tabs, destination details and the existing voting/blind-box workflows. WeChat's navigation capsule, map tiles, system font fallback and native permission/file dialogs remain platform provided.
- **State refresh:** Room pages poll `roomGateway` every two seconds for authorized state updates.

The displayed midpoint is a coordinate estimate. Participants should consider actual transit, road conditions, and accessibility before confirming a destination.

## Consent, privacy, and permissions

- The first launch opens directly to the home screen without automatic login or requests for a phone number, profile image, nickname, or location.
- Users may try the local midpoint, ledger, and spinner flows as guests. Midpoint drafts and local books are saved in a separate device guest space. Signed-in users have separate account-scoped local storage; logging in does not automatically merge guest drafts. Spinner entries remain session-only.
- A cancellable login prompt appears only when the user initiates a cloud-dependent action such as creating or joining a shared room, opening cloud history, or managing a profile.
- The Terms of Service and Privacy Guide must be opened separately. Consent is unchecked by default, and login remains disabled until the user opts in.
- Login does not request a phone number or automatically retrieve a profile image or nickname. Profile data is uploaded only after an authenticated user explicitly edits and saves it.

Before release, reconcile these actual data uses with the account's privacy-guide form and detected interfaces:

- **User information (nickname and profile image):** display member identity and prefill the user's chosen nickname.
- **Published content:** store and display room names, member names, expense descriptions, candidate destinations, and votes within the authorized room.
- **User-selected location:** call `wx.chooseLocation` only after the user chooses a starting point or candidate destination.
- **Clipboard:** write a room code only after the user presses the copy control; Pintu does not read existing clipboard contents.
- **Custom user identifier (OpenID):** identify owners and members, enforce authorization, synchronize profiles, and retrieve the user's rooms.
- **User-selected files:** import JSON ledger backups chosen from WeChat chat files; export/share a backup only after the user's tap. Files contain member names and financial records and should be shared only with trusted recipients.
- **Map search:** manually entered address keywords and submitted coordinates are sent through the CloudBase map gateway to AMap. The server uses a hashed caller identifier for rate limits. Local use does not create a saved cloud collaboration profile.

The native client uses `chooseLocation`, not background location tracking. Use the actual interface detection and available declaration options in the WeChat console; final interface approval and privacy configuration must be checked on the existing account.

## Profile-image lifecycle

New images are uploaded only to the private, account-specific path issued by a cloud function, using the form `avatars/profile-<hash>/`. When an image is replaced or a profile is removed, deletion is performed by the cloud function. Failed deletions create a private retry record that the user can retry from the profile screen. Do not make the CloudBase storage bucket publicly readable.

## Web interoperability

The web application and Mini Program share protected `schemaVersion: 5` rooms. A valid room code can be used on either platform, and authorized changes to membership, starting locations, candidate votes, and ledger entries synchronize in both directions. Cloud functions derive platform identity from trusted invocation context rather than client parameters. Content created on the web passes through the WeChat content-safety flow before it is displayed to Mini Program users.

## Release checklist

- Link the Mini Program account to the configured CloudBase environment.
- Deploy `roomGateway` and, when address search is enabled, `mapGateway`.
- Complete the WeChat privacy declarations described above.
- Request the required user-selected-location capability for `wx.chooseLocation`.
- Complete Mini Program filing and any verification needed for search or sharing.
- Test creation, joining, synchronization, voting, ledger editing, member departure, and owner dissolution on at least two physical devices.
- Test guest/account storage isolation, backup import/export, destination photos/details, and native-map controls on iOS and Android. Offline source/VM checks are not a substitute for a WeChat build and device preview.
- Use the manual preview/upload helper in [scripts/wechat-release/README.md](../scripts/wechat-release/README.md) if available, or upload from official WeChat Developer Tools. An upload produces a development version; review submission and publication are separate console actions.

Return to the [main project documentation](../README.md) for architecture, testing, deployment, and security details.
