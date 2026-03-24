# Insight Rubric

Use these heuristics to keep comment analysis concrete and repeatable.

## Hot Comment Ranking

Score comments by a weighted mix of:

- pinned status
- like count
- reply count
- information density
- question intent
- conversion-intent tags

Penalize low-signal comments such as:

- pure emoji replies
- very short reactions with no topic signal
- duplicated text

## Question Detection

Treat a comment as a question when it contains:

- `?` or `？`
- English question cues like `how`, `what`, `where`, `why`, `can`
- Chinese cues like `怎么`, `如何`, `多少钱`, `哪里`, `能不能`, `有没有`

## Topic Grouping

Group questions and intent into a small fixed vocabulary:

- `price`
- `location`
- `process`
- `contact`
- `trust`
- `eligibility`
- `timeline`
- `purchase`

Prefer deterministic keyword matching over free-form summarization.

## Conversion Signal

Classify conversion signal into three levels:

- `强`
  - multiple comments ask about price, contact, location, booking, or purchasing
- `中`
  - comments show concrete action intent but still focus on process or prerequisites
- `弱`
  - comments are mainly admiration, jokes, generic praise, or casual curiosity

Negative trust or risk comments do not erase conversion intent, but they should be called out explicitly.

## Insight Writing

Write findings as evidence-backed statements, not generic growth advice.

Prefer:

- what users are trying to find out
- what information gap is blocking action
- whether comments imply casual interest or genuine conversion intent
- whether the creator should add price, contact, process, or trust-building details

Avoid:

- broad marketing clichés
- unsupported claims about sales impact
- pretending sparse comment samples are definitive
