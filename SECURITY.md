# Security Policy

## Reporting

If you find a security issue in `emoji-osory`, open a private security advisory through GitHub if available for the repository. If GitHub private reporting is not enabled, contact the maintainer directly before opening a public issue.

## Scope

This project does not handle secrets or a production backend. The primary security surfaces are:

- browser-side canvas measurement behavior
- data integrity of committed vendor and Unicode datasets
- accidental publication of raw internal details through docs or build tooling

## Expectations for reports

Include:

- the affected version or commit
- the exact file or interface involved
- a proof of concept or clear reproduction steps
- the practical impact

## Disclosure

Please allow time for a fix and coordinated disclosure before publishing details.
