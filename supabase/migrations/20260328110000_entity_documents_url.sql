-- Switch entity documents from filename+page to a single URL field
ALTER TABLE case_entity_documents ADD COLUMN url TEXT;
UPDATE case_entity_documents SET url = filename WHERE url IS NULL;
ALTER TABLE case_entity_documents ALTER COLUMN url SET NOT NULL;
ALTER TABLE case_entity_documents DROP COLUMN filename;
ALTER TABLE case_entity_documents DROP COLUMN page;
