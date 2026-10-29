import pytest

from app.beyond_basics_action_patches import InvalidProposal, apply_proposal


def test_exact_text_only_overlay_and_no_mutation():
    components = [{"body": "<p>Chess is fun.</p>"}]
    proposal = {"status": "completed", "message": "Updated", "patches": [{"component": 0, "field": "body", "old": "Chess is fun.", "new": "Chess is enjoyable."}]}
    assert apply_proposal(components, proposal) == [{"component": 0, "field": "body", "value": "<p>Chess is enjoyable.</p>"}]
    assert components[0]["body"] == "<p>Chess is fun.</p>"


def test_invalid_or_ambiguous_proposals_fail_atomically():
    c = [{"body": "<p>same same</p>"}]
    base = {"status": "completed", "message": "", "patches": [{"component": 0, "field": "body", "old": "same", "new": "x"}]}
    for invalid in [base, {**base, "patches": [{**base["patches"][0], "old": "same same", "new": "<script>"}]}, {**base, "status": "needs-clarification"}, {**base, "patches": [{**base["patches"][0], "component": True}]}]:
        with pytest.raises(InvalidProposal):
            apply_proposal(c, invalid)
    assert c == [{"body": "<p>same same</p>"}]
    assert apply_proposal(c, {"status": "needs-clarification", "message": "Please clarify", "patches": []}) == []


def test_rejects_attribute_targets_and_link_injection():
    components = [{"body": '<a href="old">visible</a>'}]
    def proposal(old, new):
        return {"status": "completed", "message": "", "patches": [{"component": 0, "field": "body", "old": old, "new": new}]}
    with pytest.raises(InvalidProposal):
        apply_proposal(components, proposal("old", "other"))
    with pytest.raises(InvalidProposal):
        apply_proposal(components, proposal("visible", "https://example.com"))


def test_multiple_nonoverlapping_plain_text_and_overlap():
    source = [{'body': 'Move teh king safely. Protect the rook adn queen together.'}]
    patches = [{'component': 0, 'field': 'body', 'old': old, 'new': new} for old, new in [('teh', 'the'), ('adn', 'and')]]
    proposal = {'status': 'completed', 'message': '', 'patches': patches}
    assert apply_proposal(source, proposal, 'Correct the spelling')[0]['value'] == 'Move the king safely. Protect the rook and queen together.'
    with pytest.raises(InvalidProposal):
        apply_proposal(source, {**proposal, 'patches': [patches[0], patches[0]]}, 'Correct the spelling')


def test_ordinary_proofreading_and_protected_content():
    source = [{'body': 'The pieces is ready , and you recieved Nf3 from Magnus on move 12.'}]
    corrections = [('the pieces is', 'the pieces are'), (' ,', ','), ('recieved', 'received')]
    # Rules are case-sensitive: leave proper names and initial capital untouched.
    source[0]['body'] = 'On this board the pieces is ready , and you recieved Nf3 from Magnus on move 12.'
    proposal = {'status': 'completed', 'message': '', 'patches': [
        {'component': 0, 'field': 'body', 'old': old, 'new': new} for old, new in corrections]}
    result = apply_proposal(source, proposal, 'Correct the spelling and grammar and punctuation')
    assert result[0]['value'] == 'On this board the pieces are ready, and you received Nf3 from Magnus on move 12.'
    for old, new in [('Nf3', 'Nc3'), ('Magnus', 'Marcus'), ('12', '13'), ('ready', 'not ready')]:
        dangerous = {'status': 'completed', 'message': '', 'patches': [
            {'component': 0, 'field': 'body', 'old': old, 'new': new}]}
        with pytest.raises(InvalidProposal):
            apply_proposal(source, dangerous, 'Correct the grammar')
