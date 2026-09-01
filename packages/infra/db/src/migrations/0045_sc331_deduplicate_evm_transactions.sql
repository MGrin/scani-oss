-- SC-331. The EVM ledger holds 385 `etherscan` transaction rows describing
-- 166 on-chain events. 219 of those rows are copies of an event booked onto an
-- account that was never party to it, and 198 of the copies carry
-- `transfer_review = 'left_control'`, which is the one answer that books a
-- disposal. This migration reduces the population to one row per event, on the
-- account the chain says was involved.
--
-- THE WRITER, fixed in the same PR. `user_integration_credentials` is
-- UNIQUE (user_id, institution_id), so a user with three Ethereum wallets has
-- exactly ONE Ethereum credential holding ONE address.
-- `TransactionImportCoordinator` resolved a wallet import's address from that
-- row, so every Ethereum account imported whichever address won it. The
-- balance path never had the bug: `SyncWalletBalancesUseCase.makeProviderCtx`
-- synthesizes the credential from the wallet's own address. The coordinator
-- now does the same, from `accounts.metadata.walletAddress`, and refuses to
-- run when that is absent rather than falling back.
--
-- THE EVIDENCE, measured read-only against production 2026-08-17.
--
--   * One wallet is party to EVERY etherscan row: `from` on every outflow,
--     `to` on every inflow. Not one exception. Every row therefore describes that wallet,
--     and belongs on ITS account for the row's chain.
--   * The rows sit on nine accounts spanning three wallets and five chains.
--     0xb0b1...a8b9 and 0xc0ff...ff01 never sent or received any of them;
--     their own history was never fetched, because their credential lost.
--   * Placement, by whether the account was actually involved: a large
--     majority of both the outflow and the inflow rows sit on an account that
--     was NEITHER the sender nor the recipient.
--   * Grouping by (tx hash, chain, token, kind) collapses them to far fewer
--     events, and NO event has more than one row on the involved account. Most
--     outflow events are booked three times, the rest twice.
--   * The uninvolved outflow rows carry a material amount of ETH and almost as
--     many unattributed `left_control` answers. `isConfirmedDisposal` realizes
--     per ROW, so one ETH transfer booked on three accounts realized three
--     disposals — which is why SC-324's realized figure and SC-302's "left the
--     portfolio" quantity are both inflated.
--
-- WHY DELETION AND NOT RE-ANSWERING. A `transfer_review` answer is a claim
-- about a transaction. A row that should not exist has no correct answer:
-- `internal`, `left_control` and `paired` are all wrong about it. No row kept
-- here has its review touched — whether those answers are right is SC-302 and
-- SC-328, and a different question from whether the row should exist.
--
-- WHY SOME ROWS MOVE INSTEAD OF DYING. Fewer outflow rows sit on the sending
-- account than there are outflow events: a minority of outflow events and a
-- handful of inflow events have NO row on the involved account at all, only
-- copies elsewhere. Deleting "the copies" would delete those events outright. They
-- exist only elsewhere because the router is FIND-ONLY for wallet sources
-- (`isWalletDerivedSource`) — the token had no holding on the correct account,
-- so the event could only land where one existed. Every row that moves is USDC
-- or WETH; every ETH, MATIC, SAND, CODE and STETH event already has its row in
-- the right place, so nothing that moves here carries material realized PnL.
--
-- WHY TWO HOLDINGS ARE CREATED. Most of the rows that move have no holding on
-- the target account to move to. Neither target appears in `holding_exclusions` — the
-- user did not reject them at wallet review; they hold nothing today, so the
-- review never offered them. Both are created with balance 0, which is what
-- the chain says they hold. The alternative was deleting real events.
--
-- REVERSIBILITY. Every one of the 219 deleted rows is a field-for-field
-- duplicate of the row that survives its event — same quantity, same
-- occurred_at, same external_id, same token, verified for all 219. A restore
-- therefore needs only the (id, holding_id) pairs named below plus the
-- surviving row's remaining columns; no information exists in a deleted row
-- that is not also in its survivor. The 47 moved rows are restored by setting
-- `holding_id` back to the value named beside each.
--
-- SHAPE. Every statement below is scoped to named ids, so on a database that
-- does not hold this population — a fresh dev box, CI's Postgres container —
-- each one matches nothing and the migration is a no-op. The assertions are
-- written the same way: they fire on a population that has DRIFTED from what
-- was measured, and stay quiet on one that was never there. A migration that
-- hard-failed on an empty database would break every CI run (0044 is
-- data-driven for the same reason).

BEGIN;

-- Preconditions. Facts the id lists below were derived from. `0` means this
-- database simply has no EVM ledger and everything after this is a no-op;
-- anything other than 0 or 385 means the population moved after it was
-- measured, and the ids can no longer be trusted.
DO $$
DECLARE n integer; bad integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n = 0 THEN
    RAISE NOTICE 'SC-331: no etherscan rows here; migration is a no-op';
    RETURN;
  END IF;
  IF n <> 385 THEN
    RAISE EXCEPTION 'SC-331: expected 385 etherscan rows, found % — the ids in this migration are stale', n;
  END IF;

  SELECT count(*) INTO bad FROM holding_transactions
   WHERE source = 'etherscan'
     AND lower(raw_payload->>'from') IS DISTINCT FROM '0x01583d152e3225519d211b1f576d959f70ef9630'
     AND lower(raw_payload->>'to')   IS DISTINCT FROM '0x01583d152e3225519d211b1f576d959f70ef9630';
  IF bad <> 0 THEN
    RAISE EXCEPTION 'SC-331: % etherscan rows do not involve 0x0158...9630; the premise that every row describes that one wallet no longer holds', bad;
  END IF;
END $$;


-- The two holdings the moved rows need, created only where the account and
-- token they hang off actually exist — so this inserts nothing on a database
-- without this user's wallets, rather than failing a foreign key.
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000001', 'bed62cfa-9b29-4e63-8af9-827a51c846c5', 'aea44e7d-9fb7-4b36-8bb6-92d3f414d1a1', '7b2ebe42-064f-482c-a85a-80552decdea3', '0', 'etherscan', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', false, true, 'unattributed'
 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'aea44e7d-9fb7-4b36-8bb6-92d3f414d1a1')
   AND EXISTS (SELECT 1 FROM tokens   WHERE id = '7b2ebe42-064f-482c-a85a-80552decdea3')
ON CONFLICT DO NOTHING;  -- Polygon / USDC
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000002', 'bed62cfa-9b29-4e63-8af9-827a51c846c5', '34d89797-13bd-48d6-8926-2538f34deff1', 'ae79234f-14de-45b1-a477-118ff0eaf664', '0', 'etherscan', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', false, true, 'unattributed'
 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = '34d89797-13bd-48d6-8926-2538f34deff1')
   AND EXISTS (SELECT 1 FROM tokens   WHERE id = 'ae79234f-14de-45b1-a477-118ff0eaf664')
ON CONFLICT DO NOTHING;  -- Ethereum / WETH

-- Move the rows whose event has no row at all on the account that made it. Without this they would be deleted as "copies" and the event lost.
-- Ethereum / USDC — rows off an uninvolved account
UPDATE holding_transactions SET holding_id = 'b6244cf1-c928-4473-83f6-80908f0cdb31'
 WHERE id IN (
    '13b13cbd-080f-4850-be37-b9e0d9b54a0c', '19bb1c58-9a30-418f-86aa-d30d51392fdf', '1a266a8c-3554-41ae-bb19-bcc0c57980ab',
    '21b1c9ea-62dd-400a-96b7-334f0358f044', '268d3251-ac13-4118-96a2-96924bf13b07', '2e9dfac1-a86d-48f0-8308-3d1b0042a9c1',
    '32dbe7e0-5dfd-4323-893f-d3e51e71b34e', '38888923-d95f-47cd-8c42-0d405e71c7b4', '3b4cb213-7f16-45ec-9cf5-596c57fab5ce',
    '58338999-a5c9-4b2f-bbd8-491377e62d2a', '619cd62c-b0d1-4f32-979e-4ded66aa4441', '7a506816-6513-44bb-b4ac-0d2b37eedcb7',
    'eb902ce8-6265-40a2-a62e-9d54786e147c'
 );
-- Base / USDC — rows off an uninvolved account
UPDATE holding_transactions SET holding_id = 'c673eac0-899b-4cb8-8c96-6c314f115524'
 WHERE id IN (
    '6d5571d3-d607-4b51-855a-9869cd8caf3c', '77a0e263-3fc8-4961-88e0-bc02704c9d22', '84718072-2253-4958-a529-63d320c7bbb2',
    '9bc4bf23-910e-4e46-9ca5-bc35f6bcfc14', 'f4ba3e8d-cae1-49ae-a70c-84be1ba77859', 'f7f5444b-14c3-4e5f-9c07-887b4baf8189'
 );
-- Polygon / USDC — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000001'
 WHERE id IN (
    '097ebd49-8227-4c72-adca-57e12ff34487', '2e218d76-b2cd-4c05-94e9-5d84c0bc1a3a', '2e9fcd51-81d0-42fc-97e1-31760cb870cd',
    '3ae25c42-9d84-4cfd-ad7f-8ff94c03546c', '51755f8e-7e10-468f-8de4-1cbeda22e97f', '537125b8-1e31-4cdd-a130-cf7f1b9c9151',
    '63de6f2e-8a77-4750-ad9e-1999deac5509', '6653fe0c-4c54-4059-b674-f15d092c69af', '693944b9-eedb-45a6-8409-b5baf0ab6feb',
    '69fe39d1-eb41-48d1-bf7e-25c97837812b', '6bb97f00-870f-4511-a531-b4fcf6283b64', 'a356b5e1-9790-409c-a9f4-a894e0bcca9a',
    'ab29a169-4d5d-499c-adfe-b24bdac548ba', 'b25b20f9-0561-4b76-913d-d05725c76895', 'bef0148b-5343-4966-b368-21ea64ba6234',
    'c78f0b5d-7faa-424e-bee0-5781e7f54921', 'd42691a3-1a3d-4e44-9c93-1bc6e61ec7ab', 'e1cfcc67-2ae4-4d66-ada8-7cea5e016310'
 );
-- Ethereum / WETH — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000002'
 WHERE id IN (
    '0bbe24d8-69aa-4578-9621-ed28eb57ca1b', '146e3997-8e36-4fee-8000-5f910628e424', '1abd8f99-ead1-4db0-9af4-fbf6af581949',
    '3c2a9ee9-bb3b-4658-8bb2-765407c456c8', '3d1c361b-6673-4cc5-af7b-c870d9b59382', '67239141-46d5-4cba-9e2e-03f9df864951',
    '789256a3-1e58-46e9-ae9d-6bae99a2360b', '8b7a03c4-c297-40ef-9b8a-8dd7b0e2fe56', '8be93418-f298-45f6-9049-cfcf31db6a0d',
    'f49bc127-831e-4e85-b244-19befa32551f'
 );

-- The 219 surplus copies. Each duplicates an event that keeps exactly one row
-- after the moves above, field for field.
DELETE FROM holding_transactions
 WHERE id IN (
    '002281cd-d5b4-4e19-aca7-16ebea0e590d', '002e9f7c-e04c-4e6d-b4f8-465361b687ba', '01303ca5-04f7-4a2b-8d13-1d6dda491b58',
    '03336b96-746a-4fea-a809-1eace56043a4', '03c6fa8d-b230-4bde-8a4d-95705488394d', '04b7c8bb-1675-4904-8428-8812c4c3b16a',
    '087fd837-c09d-4b56-8530-6aa3d8c3abfc', '08d92bbb-0f33-4be2-92d9-1405126a1eff', '0a422d77-04ef-46ee-bf40-1434f12745e0',
    '0aa04fa2-86bf-41f8-83a4-6729f2f8d292', '0b0e71db-f05f-4f24-8f0d-1c6b078c7800', '0cd45199-f82f-44c0-bb62-cfe40ae1eaa1',
    '0ea9cd92-b307-4180-8b49-b06742ee9eda', '10e6b766-ca76-4713-8c8f-76508f2d6388', '10f5b5c5-cbb0-44e0-9021-2d134876dc81',
    '114625cb-aee7-4d89-97de-783cc4ed6363', '120c1652-411b-43b1-be3c-dad1fc3cf9ec', '131ae145-933b-4eea-9de6-42e08fbc06cf',
    '14ae8cf5-3d0f-4a9b-9a2f-c723a7f8deb7', '163c95ec-468d-4fa6-b5f3-6f13cf11c1f8', '1792c4bc-4a9e-47e6-8eec-b3d1719a721b',
    '17d4982d-230a-42d9-ad1f-75cff07f7840', '1a58130c-954e-4563-92bc-fb299a166c87', '1af0fadd-a794-4126-a975-c2ff3ae1e62a',
    '1cdfabea-1b28-47b0-85b0-c968718d9c9c', '1e770c16-ff18-478b-913a-a1c7a68e6010', '1f9e7812-0c72-4a5d-849a-6bd8bc5f16f7',
    '1fccba04-6916-4bcc-970b-dc8d59a6d7a0', '1ff1eaaa-baa4-42b8-98e6-d9c7d3446298', '21ec3daf-390b-48f5-9422-e4ebae3fa019',
    '227b6dea-be9c-450b-976d-65034fce812f', '228a45c1-65c4-4bf1-b46b-d1a7241b4253', '2499aa32-4f4f-451c-a0d2-92878dae1f1f',
    '24c4bad3-27cb-42b5-adf5-b890c1214132', '24d7deac-0f2c-4f5d-9a52-08f64144a4f4', '24f95f7b-a0b1-4acd-ac8f-6b1a513471fe',
    '27ffe779-e157-47dc-81a8-f35dbf50ca53', '2831ff8a-efcd-41c7-b5ee-1f96566968d9', '2b65f1fa-e880-412a-a8e5-00dd808680e0',
    '2e838166-b42a-4151-9842-9f127e686470', '2f2a320b-511b-45df-99b0-0c3ba61858bf', '2fc209d1-cfc4-4827-999c-75d9e134aed4',
    '300a60e3-9509-412e-9b93-7cbac67e7257', '30d42fa8-29e8-4441-8d80-9062ae47eac5', '32011761-c86a-491c-99e3-ea5e46525dff',
    '35d00a1a-cab3-4418-a8e6-c0e964943cfc', '36942de2-c4cb-4fff-9828-9ef3d1243ff3', '36badaa3-67da-4028-930b-e0e351172144',
    '3701da99-ec5d-4b0e-9828-80ceb18bf40c', '3777c727-8c6e-4375-9045-b558e572529a', '394fba90-45aa-48bf-a77e-36418f611088',
    '3953dae9-32b3-4e2b-b5e4-c333f43ad2d8', '39eb671e-2e32-41e0-b14c-943d16d4053e', '3b21e29c-1fab-439d-b4ac-026d80924c41',
    '3bdede00-dac2-48f8-99d5-71374d0645e7', '402e5969-01e2-42ec-8e8d-cfb992fa5e1f', '43c620c3-b4a8-4e28-8838-e64596416e11',
    '44cc6331-da5a-407a-8a80-a49427e46e01', '48c0c2eb-d96d-42a3-bf11-d96fb396754f', '4a2e292f-3e65-4780-ad30-cc507d39d253',
    '4d0a00b8-eb16-4fca-8a93-18ac2df75eef', '4d553ccb-aac9-4cfe-a2a2-74c5ea5466e3', '50c0a339-6869-4787-a329-57d7b580fe2f',
    '50d18b94-8c6e-4b95-a4ef-c5a3cde780be', '52a49227-97a6-46a2-a7e2-996101e3d3d9', '53da8ac8-5c4a-47ea-9ea3-ff6b54246b6d',
    '53e1e241-789d-4183-8827-ed49791912bc', '556b8c3b-9203-454a-ac4e-4e3142f54ef6', '55eac63f-6b76-4862-b3af-e62ec5e09828',
    '56154d3c-d4f2-495e-b159-b0a9d36edc20', '584240ed-e19d-47bf-9512-e228768a9542', '594d79c6-d0d2-434a-83ca-0dd7e1e4f727',
    '59d2d619-d3b7-4756-b3e7-8913fea5de99', '5a578bf5-79b5-458e-bee0-7eca8c00f45c', '5c54e4f3-d995-4e28-a670-aad1e97ae432',
    '5f5890bf-59ce-4ad1-b0bb-a41301358868', '60f26588-4fae-472e-987a-e6ada5b89301', '6233ec25-d592-4c83-8424-b28b79064aae',
    '62e66f60-a629-4cdc-969a-3f8b1a10f40d', '6366760b-9767-4bd8-bd7f-863c3db561b5', '66b43a31-be64-47e0-aa77-26763b053277',
    '673daf1e-1f19-4a92-8cf0-5db2d001d2f8', '687b876c-6133-4b63-85da-ea1a2872e855', '6ab4f50d-72bb-492f-bd54-43b0ab3f5ada',
    '6c80f2a0-9e0a-44d4-bf21-84ac67844ebb', '719cb5e2-b13d-4f01-85d1-5e0fa823aa7f', '71ae7363-9fe7-418f-9c89-9a1c79cbac51',
    '71bb8da1-925a-410d-aee7-2a3a2f276a24', '75139d2a-031e-4ee4-9fad-3b1164165986', '759ea76b-9cb8-4c41-beb7-8a3d5b114346',
    '787378c4-2d36-4e2a-8768-e41382e445b1', '7880a7b3-861a-4664-8734-9dc9ae232af8', '7966fcd6-a5cc-4299-b36b-962a99073534',
    '7976cf15-08f9-4a47-9e60-6b7f33a861f6', '7bb6facb-665e-4989-abee-bea951ac2f12', '7c01edf3-cf34-4158-a1ac-62aa94f15749',
    '7c2cd2cf-702f-4ddf-baef-c2dc3565ac93', '7cf478bf-f5df-45cf-8754-aa7d52664e25', '7e6156b2-8a63-43b6-88ee-47c294fd10af',
    '816ca328-2752-4d6a-843f-1381bd4f6621', '822f5fdd-7713-4a1a-ad2e-d5fe4897afd3', '8343146b-a7d5-43bd-a60c-56a6bd50db74',
    '8376adcb-6193-46e0-84f4-e75eb6d2dfda', '86985188-34f7-43ff-8657-6a3dce068c24', '869a0fa9-f775-4e40-abc4-16b7b925af6c',
    '87ba0df9-bd22-4f97-b4fc-09bc43651153', '882296b2-38d3-4d01-93f8-7e5e2133aa48', '88714902-94d7-469b-b896-167a719d8460',
    '89ff4c0e-d126-475b-b134-30422a42f224', '8bf68b5e-2dde-4d75-9aa5-6a5d9d2cf1d2', '8c80a54a-1484-4104-917c-7adc6ceea60a',
    '931ba3d0-d037-4d1a-a6af-40f605fabf30', '94600392-d7ae-4f63-903b-743a6d78695a', '956086d2-46be-4d4a-8693-cc3aabe29917',
    '9770af96-56b4-47b6-aaba-e271447adfc9', '989511d9-a218-46ad-a0d5-c4c992c4c311', '9968d253-ea7e-4191-81c8-fc04dc88d15e',
    '998f9e65-0c2a-45f6-8420-1220250fc2cf', '99c0779b-9061-4c0a-9d01-be42243828dd', '9ccde496-c43d-4973-bab7-22cd20ab5f99',
    '9f020659-aec4-41b7-9af4-f15a79ab65e8', 'a01c25f2-aca9-4331-9f90-c24d988d1c01', 'a06cefaf-49db-40aa-95da-6a566f744040',
    'a07107ac-01b6-4f5f-952d-952d2e935313', 'a12d1871-1886-440f-b1f6-0b8afcfc57f9', 'a310653a-4117-451e-a365-8670cb996e31',
    'a49fd86e-1787-483c-85e2-5b079bcd916c', 'a4fcca35-7431-47ce-b135-957482732345', 'a73738e4-8074-4076-8447-e2d62e62d21d',
    'a7381e08-3cd2-44ff-813f-b6889ee0fc3e', 'aa23fd77-eb6e-4324-ab3f-7c856bc242af', 'aa2cecd6-90f8-4738-ba39-8eed234e07d3',
    'ab017253-d8a2-4dc7-ad29-d5d3f1b9f5fd', 'ac3da7ae-4ff3-494d-b423-2b614338093e', 'ad8641b3-0e3d-4cbd-8fa5-af3264522e5d',
    'af332a75-aeb3-4a7a-9be9-089980a9f84c', 'af891f8c-d81c-4316-b3e0-d23f54da4dcf', 'b0e809d3-f502-4767-b277-747519d637b9',
    'b1bdd1cb-e920-4496-9823-d7b07e591c2e', 'b3039469-5f91-42c6-bc12-abf8d629a74c', 'b3283ed9-cd20-431b-8bc1-a7a2d1a6baf6',
    'b7c15dff-d48a-4926-8ce3-ffbbd4178eda', 'b937a9cb-39b9-4995-8256-769e182cbf85', 'b978ed76-9d96-433a-9283-baad15be3db4',
    'ba57e3e1-afd8-40e4-b891-7d0eec28431d', 'c12bc7f6-da8c-43d8-8c46-4857a021ae71', 'c31ffc80-4ac0-41d4-b034-bf1ac89fc881',
    'c7724791-6111-4cd9-99fd-6ed63f56c7de', 'cbeba54b-6d7c-4079-950d-a4501c16857b', 'ccc14572-48c9-422e-80cd-fe2b9e1768c7',
    'cdc13254-41b5-448a-be7c-df0f746b9b2f', 'cdeb2c9b-1517-4f79-a4ae-6d265830708d', 'cff995f1-9493-4647-9680-87e1361c18db',
    'd22cba3a-af7f-4309-8b90-f0cc5e262d97', 'd61683a9-3822-4730-8a01-30216eb3950d', 'd8b64580-c531-40a3-81dc-8d025519ea5c',
    'da5ee7f1-e3a4-4896-beaa-fc0e62d3b8d9', 'daab4532-7eb1-42cd-8a31-7d5cb5ac8546', 'db23188b-41f2-4a91-8dd9-ffd884759c71',
    'dfe2ca15-ba5a-4b65-a710-78958c332429', 'e06b231b-919c-43a9-9fae-8302827576ec', 'e0a53fb4-98c1-48e3-b79f-1dc16666604f',
    'e0bde543-dc10-4114-abd2-1db54182e8aa', 'e0f8558c-1f27-467b-b908-004b1794163b', 'e1099380-eb45-4813-986f-9247fff3e4f3',
    'e12e42fd-c46f-47db-8745-74725abb332a', 'e1ca9311-71f2-4bf9-a543-95469a496ac4', 'e52af9bf-93f2-438e-8764-5259a24eb1ad',
    'e58b8322-9c3b-4c64-b9ca-914e92bbe13b', 'e5b7be44-58c9-421e-9485-d68d31d88bda', 'e5ff3325-a0cd-4bae-8f55-1302c4cf7bc6',
    'e701b60a-4fa3-461f-ae4e-02eedd71ccdb', 'e72b94ec-756d-4227-a68a-7691b819e82d', 'e78f89a5-8eb6-432f-9b48-c5063bc577af',
    'e7bcb072-17aa-4daf-9f8e-dfd7759aaca1', 'e8eaab45-7e90-4ba6-8402-3db9f4c448c0', 'ea5703fe-7292-4e62-b99b-35b4b1d34d9c',
    'ebd3a95e-bcb9-4132-883a-7d45d044b10e', 'edc46c07-ff23-423a-8a2c-fe33855f0e9a', 'f074881e-0670-4b75-aaae-f712f081badc',
    'f217a1d4-4afd-458c-88f1-d594d63647af', 'f2f05e13-d94b-4d92-a3eb-91867c29fd31', 'f31622fc-dc39-4257-92fe-4ad3555c146a',
    'f3b4ccb2-18dd-461e-ba2c-8353e20c3e91', 'f52a7c54-0fcb-4441-9bde-c406809e226a', 'f5c8c64b-89ac-486d-8710-ef29d9a320c1',
    'f6e5b848-fb89-48d3-99fe-9b1794356961', 'f71620f3-42d9-4735-941e-516fb46aa20b', 'f764ec9e-2254-4083-bedb-c09b2ebe900f',
    'f7839ebd-b00b-44d3-a2b7-b8d221eb2a4b', 'f8fcbede-ed42-48e9-b955-f4c1cdd72e0c', 'f9b153b7-f3c6-4d34-a7ed-a30a61b43009',
    'fa5bea1b-099c-459b-88fd-03ba981139f7', 'fcc6cbfd-db77-4a5e-927a-f36d36af9874', 'fe47a3e8-928d-4144-8f35-27403316a5b9',
    'fe7f907b-62df-49b2-9506-4d16df00de97', 'febbc9e7-eb78-46ef-83ca-8bc0a038003f', 'fed961a9-11f6-4f2e-bd00-db256fed56ba',
    '32919182-7061-4a18-9981-d5a589d48835', '4f889635-febb-4b81-9f50-d3a7835bb841', '5d67603b-82d0-48cb-8edf-841dbed36e6f',
    '7b7c0c06-960b-4d0e-8808-d70aad51d51e', '7d996f49-9c37-4535-b86e-12e5a5e0bfb4', '802682c2-6b78-4a38-bf55-9a74b1b7a87f',
    'f4c35a19-550b-4d92-b736-0910e61d3a13', 'f6ebc104-52e9-4882-b222-6bc6f9f1c6d9', '2aedf1c9-ebe4-43b2-8b58-45125ded681f',
    '3aacf456-6b66-452b-be27-41af07753eaa', '6a16d923-a80a-4ba5-9647-1d9f3a665a3c', '84989f35-1427-4026-b4d8-d3cf9dbc44e5',
    '95b475ea-05e1-4eaf-a9d2-41da094d68fa', '9c994517-6e6f-4395-b6ff-cc9e65284e0c', 'ac2afebf-ed4f-4ee0-ba22-f379933c8dd1',
    'b6e0af4b-1e11-42a5-9bdf-22eb7cdc1ca4', 'cb1bdb05-cb78-4c3c-a6e3-1e6a8f3b2a21', 'e5a54ac9-bbdd-4fe5-9e8e-180cc977964f',
    'f3515e28-f555-424a-9358-c56e341a464e', 'fb093ab7-a901-4d41-b66a-14763df1781b', 'fe2fb6e5-1d49-435a-9daa-1700de3b3541'
 );

-- COVERAGE, half one: the holdings that received rows. `holding_coverage`
-- feeds `CostBasisService` as `historyCompleteness`, and the walk prices a
-- disposal differently when it does not know whether it has the full ledger.
-- The rows moved above ARE the wallet's complete etherscan history for that
-- (account, token) — the import read the whole ledger, it just filed it on the
-- wrong account — so the claim moves with them. Without this the same
-- disposals are valued differently purely because the coverage row stayed
-- behind, which was worth 365 USD of spurious WETH gain in the dry run.
INSERT INTO holding_coverage (holding_id, first_tx_at, last_tx_at, tx_sources, has_complete_tx_history)
SELECT ht.holding_id, min(ht.occurred_at), max(ht.occurred_at), ARRAY['etherscan'], true
  FROM holding_transactions ht
 WHERE ht.source = 'etherscan'
   AND ht.holding_id IN (
    'b6244cf1-c928-4473-83f6-80908f0cdb31', 'c673eac0-899b-4cb8-8c96-6c314f115524', '5c331000-0000-4331-8000-000000000001',
    '5c331000-0000-4331-8000-000000000002'
   )
 GROUP BY ht.holding_id
ON CONFLICT (holding_id) DO UPDATE
   SET first_tx_at = LEAST(holding_coverage.first_tx_at, EXCLUDED.first_tx_at),
       last_tx_at  = GREATEST(holding_coverage.last_tx_at, EXCLUDED.last_tx_at),
       tx_sources  = ARRAY(SELECT DISTINCT unnest(holding_coverage.tx_sources || EXCLUDED.tx_sources)),
       has_complete_tx_history = true,
       updated_at = now();

-- COVERAGE, half two: the holdings that lose every row. These sit on
-- two other own wallets, and each claims a COMPLETE etherscan
-- history. That claim was never true — those wallets' own history was never
-- fetched, because their credential lost the unique (user, institution) slot —
-- and after this migration it stands over an empty ledger. SC-149 made this
-- flag drive cost basis and SC-168 made a failed run retract it; leaving it
-- set here would assert completeness about a ledger nothing ever read. The
-- guard makes this a no-op for any holding that still has rows.
UPDATE holding_coverage
   SET has_complete_tx_history = false,
       updated_at = now()
 WHERE holding_id IN (
    '1fe673c6-aac5-4266-a0b9-a227f69db38d', '32e8dcdb-9832-409e-b2de-50e2c68a4a12', '0dced092-3db0-473a-8e31-6dbb5616bda2',
    '0f29f11f-cee5-4f97-b7b4-6aa34804307a', '301b73f4-04f4-4a19-8a7a-3842ad1b3cee', 'ac923d63-a31c-405c-8c04-90119ac631e1',
    '10cc6122-502c-4ce9-9981-c9fe50b87d59', '776ce13b-8099-43a2-a3fb-7b63ee730c41', '10d8bf30-a7f7-4927-a384-b32cef40457a',
    'ee4ab04e-9b23-4562-9776-c4b8b6e4f1da'
   )
   AND NOT EXISTS (
     SELECT 1 FROM holding_transactions ht
      WHERE ht.holding_id = holding_coverage.holding_id
        AND ht.source = 'etherscan');

-- Postconditions. 166 events in, 166 rows out, each on the wallet that was
-- party to it. Vacuously true on a database that held none of this.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n NOT IN (0, 166) THEN
    RAISE EXCEPTION 'SC-331: expected 166 etherscan rows after repair, found %', n;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM holding_transactions
     WHERE source = 'etherscan'
     GROUP BY raw_payload->>'hash', token_id, kind
    HAVING count(*) > 1) d;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-331: % events still hold more than one row', n;
  END IF;

  SELECT count(*) INTO n
    FROM holding_transactions ht
    JOIN holdings h ON h.id = ht.holding_id
    JOIN accounts a ON a.id = h.account_id
   WHERE ht.source = 'etherscan'
     AND lower(a.metadata->>'walletAddress') IS DISTINCT FROM CASE ht.kind
           WHEN 'transfer_out' THEN lower(ht.raw_payload->>'from')
           ELSE lower(ht.raw_payload->>'to') END;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-331: % rows remain on an account that was not party to the transaction', n;
  END IF;
END $$;

COMMIT;
