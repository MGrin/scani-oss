-- Custom SQL migration: Mark blockchain institutions with hasIntegration = true
-- This enables API integration support for all blockchain networks

-- Update all blockchain institutions to mark them as supporting integrations
-- Using specific institution IDs
UPDATE institutions 
SET has_integration = true 
WHERE id IN (
  '45ab1358-a63c-4b5b-a305-082fa208ee0f',
  '71e709cf-f8db-48a3-877a-e19dadeeb6aa',
  '8a91aba5-b7d3-4d08-99f9-d075a3c8ebc6',
  'f20ba475-99e7-4c7c-814d-cfb719b8dc4a',
  '6e5262fe-00b0-4e41-a142-8092529ff11a',
  'f0b16e81-c370-40b8-8635-6fd794cacf09',
  'a3674de1-ff78-4825-9380-1fd67f441848',
  'e47a5d6b-4bae-4569-9265-7afe4d9f571a',
  '88424064-0765-4414-8997-10456b4ab8be',
  'ec739140-c8be-4909-99a8-154b34786ac7',
  'be2f4f21-4c64-4263-aaee-8e6206001421',
  '45b8ab56-46c5-47ac-9dce-f6379c5e73c8',
  '5e422e1b-1341-4188-a5b5-e267e38166ad',
  '513e28f9-a347-40ee-9318-081d3192f25e',
  '45faf1b5-9adc-49f8-ad90-2872d41fada5',
  'e6064bef-b17c-4b66-9e73-044978137914',
  'e89b0349-8411-49ac-8352-66da90ae73ba',
  '1e7340c5-90ef-474d-beb0-127bf1d453e8',
  'e5d99e11-abe9-4ee0-a417-41163c6fe1c8',
  '1f3cf183-0b05-4f20-8278-1609efd4f15a',
  '092a0563-910a-4dd7-857c-4bb67990cb4c',
  'b06b4365-82e6-4d1e-ba04-69cd223ee67d',
  '5c9ffa69-3847-4b7c-9451-cefb9b1631e6',
  '0ffe2a0a-d03a-4130-b118-a2ca199145b1',
  '92c4a1be-7fc8-423d-a0d6-e12ac62a5891',
  '1fd50ae0-6a59-4ee8-9332-286572f5c10d',
  '8f7a5276-062b-4542-ae70-7c9a319fe37f',
  '2ece3939-2ab7-4f2c-a0a4-c4740a7f4cbd',
  '9cfaed18-421a-4f4b-bc2b-c5a6f1e37ccd',
  '015c5da6-854a-4650-90d3-05d2af61af1a',
  '0605513b-1e92-4257-9f33-cd7ae5e87cb3',
  'c9660c76-6d2a-41af-868a-ffe556e445c8',
  '0330941f-3756-4702-8ad9-1d5171559061',
  'b1c6dedd-0a51-4c70-b82b-379af1d0d647',
  '4ca5e495-a8f9-4296-8122-0ef08786c758',
  'ec9e8004-de63-468c-b326-7ba8323d1a85',
  'e44d8776-814b-4707-b64f-05e3ca69255f',
  '12ea0913-28a7-4247-a73e-4ee3f5e5615b',
  '05e7d413-817c-47fe-8ae6-19af37326765',
  '12dcf035-5c7f-44bb-87c4-901b769aebdc',
  '9a532bae-1b4d-4804-a4f5-28eda16876f9',
  '4b2775dd-082f-495f-ad6c-14cfa3e57705',
  '069d008e-06e9-485e-af86-43ad7b44c650'
);
