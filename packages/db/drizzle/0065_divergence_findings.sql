-- A Divergence an automatic overview patch keeps beside the prose (F4 D17) reaches the Inbox as a
-- high-risk `contradiction` item whose verdict persists (D29): `gardener_findings` takes a
-- `divergence` kind, one per applied patch that added Divergences (fingerprint
-- `divergence:<change-set id>`). The overview repository records it in the transaction of the write
-- and resolves it with the undo of that write. Only the kind list of the check changes; every
-- existing row keeps its values. Going back drops the divergence rows and restores the old check.
ALTER TABLE "gardener_findings" DROP CONSTRAINT "gardener_findings_values";--> statement-breakpoint
ALTER TABLE "gardener_findings" ADD CONSTRAINT "gardener_findings_values" CHECK ("gardener_findings"."kind" in ('duplicate','broken_link','redirect_chain','backlog','budget','divergence')
        and char_length("gardener_findings"."fingerprint") between 1 and 200
        and jsonb_typeof("gardener_findings"."object_refs") = 'array' and jsonb_array_length("gardener_findings"."object_refs") <= 50
        and jsonb_typeof("gardener_findings"."params") = 'object'
        and "gardener_findings"."risk" in ('low','medium','high')
        and "gardener_findings"."status" in ('open','dismissed','resolved')
        and ("gardener_findings"."status" = 'open') = ("gardener_findings"."closed_at" is null));
