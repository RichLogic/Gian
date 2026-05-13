-- Rename ApprovalMode enum: 'default' → 'ask'.
--
-- Code around the same migration drop the legacy 'default' value entirely;
-- the new ApprovalMode union is 'plan' | 'ask' | 'auto'. 'auto' rows are
-- preserved as-is. Any existing 'default' rows become 'ask' (semantically
-- equivalent — both relay every approval to the user).

UPDATE sessions SET approval_mode = 'ask' WHERE approval_mode = 'default';
