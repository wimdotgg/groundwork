# Changelog

## [0.10.1](https://github.com/wimdotgg/groundwork/compare/v0.10.0...v0.10.1) (2026-11-23)


### Bug Fixes

* **ci:** build the release when a release PR merges through the queue ([#244](https://github.com/wimdotgg/groundwork/issues/244)) ([feeb272](https://github.com/wimdotgg/groundwork/commit/feeb2720369d03959ed400dd7054f36da88b0773))
* **ci:** dispatch release-please on main from the closed run ([#248](https://github.com/wimdotgg/groundwork/issues/248)) ([bc5be24](https://github.com/wimdotgg/groundwork/commit/bc5be24b800f75b64fc2116b2384e941513d0f0c))

## [0.10.0](https://github.com/wimdotgg/groundwork/compare/v0.9.0...v0.10.0) (2026-11-22)


### Features

* **spec:** mark the spec v1 done, run the final check and release ([#239](https://github.com/wimdotgg/groundwork/issues/239)) ([04da522](https://github.com/wimdotgg/groundwork/commit/04da5226820988968177b5d3f1f03ac3e79d5798))

## [0.9.0](https://github.com/wimdotgg/groundwork/compare/v0.8.0...v0.9.0) (2026-11-22)


### Features

* **agent:** fail closed without the token.mjs exec token ([#225](https://github.com/wimdotgg/groundwork/issues/225)) ([4f9a73a](https://github.com/wimdotgg/groundwork/commit/4f9a73a2f49042fdd6b1922d90440d62de626427))


### Bug Fixes

* **agent:** deny every bare gh call instead of per-subcommand rules ([#230](https://github.com/wimdotgg/groundwork/issues/230)) ([76a6f72](https://github.com/wimdotgg/groundwork/commit/76a6f72e45eab2ade1a6cdc6ca469fee2a904a14))
* **agent:** deny gh config and alias writes, drop bare-read docs ([#228](https://github.com/wimdotgg/groundwork/issues/228)) ([879c2d4](https://github.com/wimdotgg/groundwork/commit/879c2d458f561355603ed2c25d343985d522bbfa))

## [0.8.0](https://github.com/wimdotgg/groundwork/compare/v0.7.0...v0.8.0) (2026-11-22)


### Features

* **kit:** align the spec and adopter docs with Phase 4c ([#212](https://github.com/wimdotgg/groundwork/issues/212)) ([756d1e3](https://github.com/wimdotgg/groundwork/commit/756d1e3e57cd90101f73b08a7bef37066b4e5468))

## [0.7.0](https://github.com/wimdotgg/groundwork/compare/v0.6.0...v0.7.0) (2026-11-21)


### Features

* **groundwork:** add deploy.yml and the deploy-record helper ([#204](https://github.com/wimdotgg/groundwork/issues/204)) ([529c0e9](https://github.com/wimdotgg/groundwork/commit/529c0e99d1518269f8cdb26ef154d4204278d334))
* **groundwork:** add the deploy, smoke and rollback project stubs ([#206](https://github.com/wimdotgg/groundwork/issues/206)) ([0f7903d](https://github.com/wimdotgg/groundwork/commit/0f7903d97e7e57a5224fd68af09c6501bc7986c6))
* **groundwork:** add the script admin op and admin-ops/ ([#203](https://github.com/wimdotgg/groundwork/issues/203)) ([45b4223](https://github.com/wimdotgg/groundwork/commit/45b4223c52fa3519765d64a3d844816b379fefd1))
* **groundwork:** add the selftest admin op ([#209](https://github.com/wimdotgg/groundwork/issues/209)) ([9356443](https://github.com/wimdotgg/groundwork/commit/93564435c196e6df049e4670fed0cccc9edcf64e))
* **groundwork:** add the selftest probes ([#207](https://github.com/wimdotgg/groundwork/issues/207)) ([3bec183](https://github.com/wimdotgg/groundwork/commit/3bec18314f99e471075d0c97ba14f76946b6ef24))
* **groundwork:** fix the Phase 4c contract and register script and selftest ops ([#201](https://github.com/wimdotgg/groundwork/issues/201)) ([817e102](https://github.com/wimdotgg/groundwork/commit/817e1023e8a2807b313a6f3a7d8502e02823fba1))
* **kit:** add kit-update to copy kit paths from a release tag ([#205](https://github.com/wimdotgg/groundwork/issues/205)) ([51c5541](https://github.com/wimdotgg/groundwork/commit/51c5541f0c9c85ffc12c447d7348ac8c4b2674e6))
* **kit:** kit-update owns the reusable-workflow SHA pins ([#208](https://github.com/wimdotgg/groundwork/issues/208)) ([95429e4](https://github.com/wimdotgg/groundwork/commit/95429e4bf6f3007fa62aaae22e9e4dc3c851c066))

## [0.6.0](https://github.com/wimdotgg/groundwork/compare/v0.5.0...v0.6.0) (2026-11-21)


### Features

* **groundwork:** let bootstrap-pass2 target the control repository ([#188](https://github.com/wimdotgg/groundwork/issues/188)) ([192c481](https://github.com/wimdotgg/groundwork/commit/192c481a2a97104727d1b7d8ae76b32f567c974f))
* **groundwork:** refuse a bootstrap rerun once the setup epic is accepted or closed ([#181](https://github.com/wimdotgg/groundwork/issues/181)) ([fc9f279](https://github.com/wimdotgg/groundwork/commit/fc9f279000ba37f811edb98107b46683694f8e5f))
* **groundwork:** run pass 2 and check on groundwork, align the spec ([#189](https://github.com/wimdotgg/groundwork/issues/189)) ([b6105a5](https://github.com/wimdotgg/groundwork/commit/b6105a540327e1b469ea7bfc834b1305edc24300))


### Bug Fixes

* **groundwork:** follow run pages when looking up the CodeQL default-setup run ([#180](https://github.com/wimdotgg/groundwork/issues/180)) ([9b2fc5c](https://github.com/wimdotgg/groundwork/commit/9b2fc5c32c7fd19c71dd3446787586f0851cdc0a))

## [0.5.0](https://github.com/wimdotgg/groundwork/compare/v0.4.0...v0.5.0) (2026-11-21)


### Features

* **groundwork:** bootstrap-pass2 CodeQL default setup, code_scanning rule and DEPLOY_ENABLED ([#161](https://github.com/wimdotgg/groundwork/issues/161)) ([e94da42](https://github.com/wimdotgg/groundwork/commit/e94da4202b696d6d350085bd10b013e906b67d5e))
* **groundwork:** bootstrap-repo module for repo creation and the bootstrap commit ([#158](https://github.com/wimdotgg/groundwork/issues/158)) ([19bcd1f](https://github.com/wimdotgg/groundwork/commit/19bcd1ffca3f49e8313312633745b7a4595fb7a3))
* **groundwork:** build the project tree from a release tag ([#157](https://github.com/wimdotgg/groundwork/issues/157)) ([05c3836](https://github.com/wimdotgg/groundwork/commit/05c38369b1a88d9fc78517c24569dd3c4c779079))
* **groundwork:** open the Project setup epic from setup templates ([#159](https://github.com/wimdotgg/groundwork/issues/159)) ([8c885f7](https://github.com/wimdotgg/groundwork/commit/8c885f7e32a718ec768afb8a984873c955814a26))
* **groundwork:** register bootstrap ops and add the withToken hook ([#156](https://github.com/wimdotgg/groundwork/issues/156)) ([7c4c3ad](https://github.com/wimdotgg/groundwork/commit/7c4c3adb058715ad8f9b2fe4ebfdbb93bb0a253a))
* **groundwork:** run bootstrap pass 1 with labels before dependabot.yml ([#163](https://github.com/wimdotgg/groundwork/issues/163)) ([88736e0](https://github.com/wimdotgg/groundwork/commit/88736e023fdde8a30892ece26049195772cec12c))

## [0.4.0](https://github.com/wimdotgg/groundwork/compare/v0.3.0...v0.4.0) (2026-11-21)


### Features

* **agent:** add plan-lint --close to check an epic before the owner closes it ([#136](https://github.com/wimdotgg/groundwork/issues/136)) ([9ee63f9](https://github.com/wimdotgg/groundwork/commit/9ee63f9ce80db2e91698df87e7c26de26b0c9725))
* **agent:** add plan-lint.mjs to enforce the planning rules ([#132](https://github.com/wimdotgg/groundwork/issues/132)) ([228ebaf](https://github.com/wimdotgg/groundwork/commit/228ebaffbe8707cd5c4ad113dd3211a642916602))
* **agent:** add review-queue.mjs to list PRs awaiting review ([#133](https://github.com/wimdotgg/groundwork/issues/133)) ([db2583f](https://github.com/wimdotgg/groundwork/commit/db2583f0a92ff8e79a71aca1d54f69f31f7bf9d4))
* **ci:** lint epics on issue events with plan-lint.yml ([#137](https://github.com/wimdotgg/groundwork/issues/137)) ([a55e422](https://github.com/wimdotgg/groundwork/commit/a55e4220933d817ee04c6239941a4f45dbe92076))
* **human:** add inbox.mjs to list what waits on the owner ([#134](https://github.com/wimdotgg/groundwork/issues/134)) ([61d9af3](https://github.com/wimdotgg/groundwork/commit/61d9af3de5f854bfc21f8976f9a756e42ac10518))
* **skills:** add the planner and reviewer skills ([#138](https://github.com/wimdotgg/groundwork/issues/138)) ([3fd5853](https://github.com/wimdotgg/groundwork/commit/3fd585343031c53ccd204944a5b2f62d78304f52))

## [0.3.0](https://github.com/wimdotgg/groundwork/compare/v0.2.0...v0.3.0) (2026-11-20)


### Features

* **agent:** add checkpoint hooks, permission rules and worker skill ([#112](https://github.com/wimdotgg/groundwork/issues/112)) ([ab94fba](https://github.com/wimdotgg/groundwork/commit/ab94fbaa60c6ba09905f1017b5294e54f89b9086))
* **agent:** add checkpoint.mjs to push, rewrite State and post the journal ([#105](https://github.com/wimdotgg/groundwork/issues/105)) ([addac33](https://github.com/wimdotgg/groundwork/commit/addac335491b01ea1eee9298d8f1a95b460a8142))
* **agent:** add claim.mjs for fresh claims ([#104](https://github.com/wimdotgg/groundwork/issues/104)) ([23692fe](https://github.com/wimdotgg/groundwork/commit/23692fefa0e668a56467bf4a4543897fcc484996))
* **agent:** add release.mjs for decision release and handover ([#107](https://github.com/wimdotgg/groundwork/issues/107)) ([0f849fa](https://github.com/wimdotgg/groundwork/commit/0f849fa1ca5e977f4d6fa05587c900fa27ed4a51))
* **agent:** add resume briefing script ([#108](https://github.com/wimdotgg/groundwork/issues/108)) ([dd2da9e](https://github.com/wimdotgg/groundwork/commit/dd2da9e8ca865885479e516f7b22bf0b1a175c00))
* **agent:** fix the agent comment and CLI contract ([#101](https://github.com/wimdotgg/groundwork/issues/101)) ([4f988b2](https://github.com/wimdotgg/groundwork/commit/4f988b222fb2ec5e5af41cc3b694d252eab4b3c3))
* **agent:** rank ready tasks and takeover candidates in next.mjs ([#106](https://github.com/wimdotgg/groundwork/issues/106)) ([f580341](https://github.com/wimdotgg/groundwork/commit/f580341d36752fc269ae5996830f675d02f524ff))
* **agent:** skip tasks whose hotspot an open PR holds in next.mjs ([#114](https://github.com/wimdotgg/groundwork/issues/114)) ([98ef95a](https://github.com/wimdotgg/groundwork/commit/98ef95a104be2fe0c11cbaf40171fcdf14afc063))
* **agent:** take over expired or released claims in claim.mjs ([#118](https://github.com/wimdotgg/groundwork/issues/118)) ([2e18485](https://github.com/wimdotgg/groundwork/commit/2e1848536dbf892fff5f14adbefd80478b15fd30))


### Bug Fixes

* **ci:** print settings-plan section status to the job log ([#113](https://github.com/wimdotgg/groundwork/issues/113)) ([8d20fe2](https://github.com/wimdotgg/groundwork/commit/8d20fe29ed70d6ca99cf6a206b6b4b9d46fe5026))
* **ci:** read automatic_base_change_succeeded from issue events ([#116](https://github.com/wimdotgg/groundwork/issues/116)) ([f3c852e](https://github.com/wimdotgg/groundwork/commit/f3c852ec227e3687742466f88b7d98111cbf325c))
* **ci:** record that settings-plan cannot read environments ([#119](https://github.com/wimdotgg/groundwork/issues/119)) ([56cc7b7](https://github.com/wimdotgg/groundwork/commit/56cc7b7847996f7915fbfdbca7568a0530d9ed32))

## [0.2.0](https://github.com/wimdotgg/groundwork/compare/v0.1.0...v0.2.0) (2026-11-20)


### Features

* **agent:** act as the wimdotgg-agent GitHub App ([#71](https://github.com/wimdotgg/groundwork/issues/71)) ([1c5556d](https://github.com/wimdotgg/groundwork/commit/1c5556d22dba78c6586c40354814028c80b65186))

## 0.1.0 (2026-11-17)


### Features

* add issue and State templates for agents ([217fe15](https://github.com/wimdotgg/groundwork/commit/217fe151f59d74ffa843c71f4442deb5d09938ce))
* add issue and State templates for agents ([3b5b3ee](https://github.com/wimdotgg/groundwork/commit/3b5b3ee20f7948f972545b5dc41b9ec8df531175))
* add issue forms for epics, features, bugs, chores and spikes ([7b38a08](https://github.com/wimdotgg/groundwork/commit/7b38a086cc4563ddd06328103f47200348f7a950))
* add issue forms for epics, features, bugs, chores and spikes ([ca34e0f](https://github.com/wimdotgg/groundwork/commit/ca34e0f7dd14736d2e139fae6b5d5a517dc953b6))
* **admin:** add admin-run workflow and runner ([2f32910](https://github.com/wimdotgg/groundwork/commit/2f32910b26fcc9a07768a423dab9cd36658c2376))
* **admin:** add admin-run workflow and runner ([85bfa15](https://github.com/wimdotgg/groundwork/commit/85bfa15e5322e4c62525203960f4567c4d190ad9))
* **admin:** add apply-settings op ([cc3c18b](https://github.com/wimdotgg/groundwork/commit/cc3c18b5719f10541c8a17985d90e34bf833cb22))
* **admin:** add apply-settings op ([fb57b73](https://github.com/wimdotgg/groundwork/commit/fb57b739839930a8be75d3dee172e5333c839325))
* **admin:** add check op ([ddbd96b](https://github.com/wimdotgg/groundwork/commit/ddbd96b78aecf56dbb5d44502663ffd7d5c58ab0))
* **admin:** add check op ([18c4701](https://github.com/wimdotgg/groundwork/commit/18c4701c57e45b41628bddd93b288ce3437564d6))
* **admin:** add create-issue-types op ([d63e75f](https://github.com/wimdotgg/groundwork/commit/d63e75f4218152026548a5876354b6332a685690))
* **admin:** add create-issue-types op ([9799ff7](https://github.com/wimdotgg/groundwork/commit/9799ff7767749bf2920ebf94635b1b8254e658dd))
* **admin:** add request.mjs for admin-run dispatch and the push probe ([578bb72](https://github.com/wimdotgg/groundwork/commit/578bb725cdc0c998e50b418199eb23795a8834ea))
* **admin:** add request.mjs for admin-run dispatch and the push probe ([3f2875c](https://github.com/wimdotgg/groundwork/commit/3f2875c917518a5ff63aef6700150ba476c4da6b))
* **admin:** mint scoped installation tokens ([eb75158](https://github.com/wimdotgg/groundwork/commit/eb751582076d75d00a7cef46b7ad16f0d4c30672))
* **admin:** mint scoped installation tokens ([cdee96a](https://github.com/wimdotgg/groundwork/commit/cdee96a4046e9dc480684f3ddc3994fd097c3862))
* **ci:** add check-results validator ([937a758](https://github.com/wimdotgg/groundwork/commit/937a758341057a9a0991794f65df8e526bf11801))
* **ci:** add check-results validator ([6fe70e1](https://github.com/wimdotgg/groundwork/commit/6fe70e1f39915dfcb72575bdf43a5fe18ab6dd83))
* **ci:** add issue-format validator ([69874a9](https://github.com/wimdotgg/groundwork/commit/69874a9f67d95d40c92b94d11976be02a3af2f57))
* **ci:** add issue-format validator ([9830b5e](https://github.com/wimdotgg/groundwork/commit/9830b5ec101030174cbe7b80054f3e068370cc52))
* **ci:** add PR metadata validator ([a6dacd0](https://github.com/wimdotgg/groundwork/commit/a6dacd093556b74a5496e35c3f5b7b03dddf6e1a))
* **ci:** add PR metadata validator ([bd59191](https://github.com/wimdotgg/groundwork/commit/bd59191c5655b147c1c3a3da4a690e531bb22485))
* **ci:** add pr-size validator ([3463b6a](https://github.com/wimdotgg/groundwork/commit/3463b6a7d93aab07ba97250cc762ea7ed3548f8f))
* **ci:** add pr-size validator ([b5ba8cd](https://github.com/wimdotgg/groundwork/commit/b5ba8cdbf6f3dc2f398eeb1de54d329b567b90e2))
* **ci:** add protected-labels validator ([1b57a90](https://github.com/wimdotgg/groundwork/commit/1b57a90f9a60c86adfdb46cd587a4c28c508c659))
* **ci:** add protected-labels validator ([2631949](https://github.com/wimdotgg/groundwork/commit/263194992e690299ef5ed4366298c38ee092063f))
* **ci:** add settings-plan validator ([f000537](https://github.com/wimdotgg/groundwork/commit/f000537f7ea336c1c6a254b83f77b50601ee53c1))
* **ci:** add settings-plan validator ([f63c604](https://github.com/wimdotgg/groundwork/commit/f63c60499c4372699019d813e9c82a2b626ac99d))
* **ci:** add test-integrity validator ([b214731](https://github.com/wimdotgg/groundwork/commit/b21473156e8d158201774ed98f2ef2d80609f095))
* **ci:** add test-integrity validator ([57a4e68](https://github.com/wimdotgg/groundwork/commit/57a4e6873a1df7a75e6efa554d547714fd2319a9))
* **ci:** open alert issues for failed release and deploy runs ([c850f7b](https://github.com/wimdotgg/groundwork/commit/c850f7b8010a7d0cd4bfce0a46ff20d51c019e6a))
* **ci:** open alert issues for failed release and deploy runs ([08d4477](https://github.com/wimdotgg/groundwork/commit/08d4477450199b35254b98d416b55d96aaa82a80))
* **lib:** add CI validator runner ([c504841](https://github.com/wimdotgg/groundwork/commit/c50484153433b78463ff873f7e9c97173b6f2f1e))
* **lib:** add CI validator runner ([ad0e277](https://github.com/wimdotgg/groundwork/commit/ad0e277a8a95c2e4fd1df83cc28b9690a4cf687f))
* **lib:** add config and trust modules ([ccb5fca](https://github.com/wimdotgg/groundwork/commit/ccb5fcaf44dad6c60cbdebd2c440aa95fdd65560))
* **lib:** add config and trust modules ([278a16a](https://github.com/wimdotgg/groundwork/commit/278a16ac0ad9256287e553272877f1206477acba))
* **lib:** add GitHub client module ([86a63e2](https://github.com/wimdotgg/groundwork/commit/86a63e22b53aca6956a1e70ee94651d8775a2bfe))
* **lib:** add GitHub client module ([d005edd](https://github.com/wimdotgg/groundwork/commit/d005edd9484cc744f961f2f5b94a55627204c7db))
* **lib:** add issue model rules ([91d13d5](https://github.com/wimdotgg/groundwork/commit/91d13d55cb718e2d0981fcfd5c66b2f2b540b820))
* **lib:** add issue model rules ([314907c](https://github.com/wimdotgg/groundwork/commit/314907c018e573035826b620a437cc5eab108465))
* **lib:** add markdown parsing module ([b897345](https://github.com/wimdotgg/groundwork/commit/b897345d57db4fced6c201f42d9cd27d5c534e9a))
* **lib:** add markdown parsing module ([4fb9839](https://github.com/wimdotgg/groundwork/commit/4fb983978a047193ab45ab4d6de8fc4ded33ad1f))
* **lib:** add settings loading and comparison ([2faedfb](https://github.com/wimdotgg/groundwork/commit/2faedfb7879282c62322eb0043343d1bce55208d))
* **lib:** add settings loading and comparison ([e27a7dd](https://github.com/wimdotgg/groundwork/commit/e27a7dd883c1056cf3aeaa3a0627c53575c67ebc))
* **lib:** load issue facts from GitHub ([23bc10f](https://github.com/wimdotgg/groundwork/commit/23bc10fa6fcacdb4f6e17fe9a968b3d0302a2b9d))
* **lib:** load issue facts from GitHub ([c7fd351](https://github.com/wimdotgg/groundwork/commit/c7fd351ae341e9119424d93f94ff8eed4256c2cf))
* **lib:** read live repository settings and signals ([a9f1eef](https://github.com/wimdotgg/groundwork/commit/a9f1eef92fdbd21a0915f1c196c47ba77826ab46))
* **lib:** read live repository settings and signals ([7dc4201](https://github.com/wimdotgg/groundwork/commit/7dc4201982dcefb8e1a6e7c71717258d4239d330))


### Bug Fixes

* **admin:** keep apply-settings fail-closed on the pass-2 gate ([275de2b](https://github.com/wimdotgg/groundwork/commit/275de2bbbee675c0a2f05d42b6b397b14b20324c))
* **admin:** keep issue types exact and delete only GitHub defaults ([bcae1bb](https://github.com/wimdotgg/groundwork/commit/bcae1bb4deb73c883a22eb6d7b1f548d5cf7286a))
* **admin:** make check fail on empty or unreadable state ([c8dc85f](https://github.com/wimdotgg/groundwork/commit/c8dc85f09ba8487234568ad10cf410542f242189))
* **admin:** make the push probe fail closed when main moves ([d313e2d](https://github.com/wimdotgg/groundwork/commit/d313e2d98773b882fce05641248c3a6289f96a76))
* **admin:** make token minting fail closed and explicit about scope ([3cdf262](https://github.com/wimdotgg/groundwork/commit/3cdf262d11b849413ac1dc258af4f1a6b897c2d2))
* **admin:** refuse ruleset applies that would drop main or its scanning rule ([e8b67bc](https://github.com/wimdotgg/groundwork/commit/e8b67bc4fbe2d2580cf00c936940cb043077d805))
* **admin:** request actions_variables, the App permission key for repository variables ([b3eae24](https://github.com/wimdotgg/groundwork/commit/b3eae241132c88a5f99f615222ab2204e030f38a))
* **admin:** request actions_variables, the App permission key for repository variables ([34b586e](https://github.com/wimdotgg/groundwork/commit/34b586e0a81dfeaa7faf95fe6edf61c0376ebe7d))
* align issue form hints with the criteria checklist format ([d0df5f9](https://github.com/wimdotgg/groundwork/commit/d0df5f9fe430c6be24a486b83af9c53e9f90edb8))
* **ci:** close PR metadata dodges ([ac4a6cd](https://github.com/wimdotgg/groundwork/commit/ac4a6cdb749acb36b565be95b8837b48792978ab))
* **ci:** close pr-size exclusion and label gaps ([19e8c0b](https://github.com/wimdotgg/groundwork/commit/19e8c0bfeffbc122ca2271b002cb955226f47c2e))
* **ci:** judge no-issue freshness by the head's first run in this PR ([aa86007](https://github.com/wimdotgg/groundwork/commit/aa86007dc2f1ed19633d65b290193a2ea5e22a27))
* **ci:** keep one failure alert per workflow ([b3ef71b](https://github.com/wimdotgg/groundwork/commit/b3ef71bd27d2890047db3209230bc50fb0d3fe3b))
* **ci:** make protected-labels fail closed on malformed payloads ([e51684c](https://github.com/wimdotgg/groundwork/commit/e51684cfccfa6580497b03af9861a4de63b1a4f2))
* **ci:** make test-integrity resistant to dodges ([a4ac941](https://github.com/wimdotgg/groundwork/commit/a4ac9410e04adad305cdb6c0f8e4fabc5f340b4e))
* **ci:** refuse no-issue for fork heads and lagging pushes ([bb2ffbc](https://github.com/wimdotgg/groundwork/commit/bb2ffbc4a4528763a5b4494a2ad24fc780509f0e))
* **ci:** require no-issue to be re-applied after new commits ([896ccbf](https://github.com/wimdotgg/groundwork/commit/896ccbfb465864bc4aa231dfe94216abcbd14161))
* **ci:** require no-issue to be re-applied after new commits ([24f3146](https://github.com/wimdotgg/groundwork/commit/24f314616056b872803a2fe89124e0f8686088bc))
* **ci:** sanitise issue-format comments and always clear needs-format ([64688bd](https://github.com/wimdotgg/groundwork/commit/64688bdc6d0a40c4c55597390b5d429722955687))
* **ci:** sanitise settings-plan output and validate settings shapes ([4c8588e](https://github.com/wimdotgg/groundwork/commit/4c8588ed8baf2881ea20d15cea0e985e6f07a0a8))
* **ci:** take no-issue freshness from the push of the head commit ([da7fbaa](https://github.com/wimdotgg/groundwork/commit/da7fbaad2691fa3778d4c5891c34cefd619aed80))
* **ci:** verify added files when GitHub omits their patch ([b0dfff3](https://github.com/wimdotgg/groundwork/commit/b0dfff355e51634da6a72801a03d888a4134a013))
* **ci:** verify added files when GitHub omits their patch ([14c25d5](https://github.com/wimdotgg/groundwork/commit/14c25d538c283277edf8e2ce14072864fad113d4))
* correct CODEOWNERS comment, Dependabot cooldown and PR template State ([b794389](https://github.com/wimdotgg/groundwork/commit/b79438982f9fe4782ed9d9c77928984e602e19ce))
* **lib:** apply review findings to GitHub client ([24875c6](https://github.com/wimdotgg/groundwork/commit/24875c6dbc455ae64c3dcaea06cc48e299f33751))
* **lib:** apply review findings to issue model ([d589906](https://github.com/wimdotgg/groundwork/commit/d589906b708342d6bfd1053fe1f212713fbc8f02))
* **lib:** apply review findings to markdown parsers ([7d204c5](https://github.com/wimdotgg/groundwork/commit/7d204c50e7a9c153cacd66fd3a1b39408abc47b1))
* **lib:** harden issue facts loading ([4a58dae](https://github.com/wimdotgg/groundwork/commit/4a58dae9d44f13900563031fffc7985284692f54))
* **lib:** make live settings reads fail closed ([000e69c](https://github.com/wimdotgg/groundwork/commit/000e69cbb887a45752ba810559d2ed4ba8094a8c))
* **lib:** make settings comparison fail closed ([b9630c4](https://github.com/wimdotgg/groundwork/commit/b9630c45abb0c447302f763b82cbb146147a158b))
* **lib:** make the CI runner fail closed ([f41380b](https://github.com/wimdotgg/groundwork/commit/f41380b47a1383aef93bd104b38ccf68e5ebdc0e))
