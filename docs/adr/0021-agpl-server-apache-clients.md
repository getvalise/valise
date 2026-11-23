# 0021. AGPL server, Apache clients, no CLA

Date: 2026-11-03
Status: accepted

## Context

The repository goes public. Until now the server was FSL-1.1-ALv2 and the
packages under `clients/` were Apache-2.0, a split settled in the 2026-10-12
grilling (`docs/research/2026-10-12-landscape-and-prior-art.md`) when Valise
was a dogfood project with a possible paid tier.

What publishing is for changed. The owner wants people to try Valise and to
see the work, not to sell licenses. Home users and companies running it for
themselves are welcome. The one outcome to prevent is a company selling Valise
as a hosted product.

FSL forbids that outright, but it is source-available, not open source. It is
not on the OSI list, many readers and package indexes treat it as proprietary,
and "fair source" invites the licensing argument instead of a trial. No OSI
license forbids commercial hosting; that freedom is part of the definition.

Every one of the 1,011 commits before this record has one author, the owner,
so relicensing needs no one else's consent.

## Decision

- Everything outside `clients/` is AGPL-3.0-only. `LICENSE` holds the text;
  `NOTICE` states the scope and the copyright.
- Each package under `clients/` stays Apache-2.0, so the plugin and the
  extension can ship inside other tools without network-copyleft terms.
- "Only", not "or later": a future AGPL version from the FSF does not apply
  without a decision here.
- The name is not licensed. A fork offered as a hosted service or a product
  takes another name and logo; README, "Name and trademark".
- Contributions are inbound = outbound: a contribution carries the license of
  the files it changes. No CLA and no DCO sign-off.

## Consequences

- A hosted competitor has to publish every change it makes to the server, and
  cannot use the name. It is not forbidden. Anyone willing to run unmodified
  or published code under another name may sell it as a service.
- Valise is OSI open source, which is the label that gets a project tried and
  linked.
- AGPL section 13 obliges anyone who runs a modified server for others to
  offer them its source. The console has no "Source" link today, so a fork
  meets the obligation by its own means. A link a self-hoster can point at
  their fork would make compliance the default.
- Without a CLA, code from outside contributors stays theirs under
  AGPL-3.0-only. Moving back to a non-OSI license, or selling a commercial
  exception, would need their consent or a rewrite of their code. Until the
  first outside merge, that set is empty. A CLA would keep the option open at
  the cost of drive-by contributions and of the reading that AGPL plus a CLA
  sets up a later relicense.
- AGPL keeps some companies from adopting the server at all; their policies
  ban it. That is the audience the owner was willing to lose.
- The FSL text no longer applies to new versions. Nobody outside received the
  code under FSL while the repository was private, so no earlier release
  carries a two-year Apache conversion anyone can hold.
