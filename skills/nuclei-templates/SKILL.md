---
name: nuclei-templates
description: 'How to search and run public Nuclei templates against in-scope hosts only.'
---

# Nuclei templates

Public templates live in `projectdiscovery/nuclei-templates`. Keep a checkout under `/workspace/tools/nuclei-templates`.

## Run

```
sandbox_exec: nuclei -u <in-scope-url> -t /workspace/tools/nuclei-templates -severity low,medium,high,critical -o /workspace/pd-oss/nuclei.jsonl -j
```

Always `scope_check` first. Use `-exclude-id` / tags to skip DoS and intrusive templates (`dos`, `fuzz`) unless explicitly approved.

## Search

`nuclei -tl` lists ids. Filter by technology from recon (`-tags cve,exposure,config` plus a tech tag). Do not run the entire tree blindly against a fragile host.

## Evidence

Save command, template id, matched URL, and excerpt. Template match ≠ confirmed vuln; send claims to the judge.
