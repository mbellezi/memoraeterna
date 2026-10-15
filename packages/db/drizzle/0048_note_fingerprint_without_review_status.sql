-- Approving a note no longer changes the fingerprint of the source-relation evidence derived from it.
-- Re-key every stored fingerprint that matches the former formula under any live review status, so
-- evidence made stale only by an approval becomes current again. Idempotent: a re-keyed row no longer
-- matches the former formula.
update source_relation_evidence e
   set snapshot = jsonb_set(e.snapshot, '{noteFingerprint}', to_jsonb(md5(concat_ws('|',
         n.id::text, n.relation_type, n.status::text, n.metadata::text,
         least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
               concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
         greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                  concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))))
  from atomic_note_relations n, atomic_notes a, atomic_notes b
 where n.id = e.note_relation_id and a.id = e.source_note_id and b.id = e.target_note_id
   and e.snapshot->>'noteFingerprint' in (
     select md5(concat_ws('|', n.id::text, n.relation_type, n.status::text, n.metadata::text,
              least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,sa,a.supersession_status),
                    concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,sb,b.supersession_status)),
              greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,sa,a.supersession_status),
                       concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,sb,b.supersession_status))))
       from unnest(array['active','pending_review','approved']) sa,
            unnest(array['active','pending_review','approved']) sb);
