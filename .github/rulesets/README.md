# Repository Rulesets

JSON definitions here are the source of truth for the repo's GitHub
Rulesets. They are applied **manually** by a repo admin — there is no
automation, because `GITHUB_TOKEN` cannot manage rulesets (it lacks the
`administration` scope, and that scope cannot be granted via a workflow
`permissions:` block).

## Apply a ruleset

First time (creates):

```bash
gh api --method POST repos/MGrin/scani-oss/rulesets --input .github/rulesets/main.json
```

Subsequent edits (updates the existing ruleset by ID):

```bash
ID=$(gh api repos/MGrin/scani-oss/rulesets --jq '.[] | select(.name=="main-protection") | .id')
gh api --method PUT "repos/MGrin/scani-oss/rulesets/$ID" --input .github/rulesets/main.json
```

## Verify

```bash
gh api repos/MGrin/scani-oss/rulesets --jq '.[] | {id, name, enforcement}'
```

Or visit <https://github.com/MGrin/scani-oss/rules>.
