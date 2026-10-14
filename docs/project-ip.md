# Who holds a project's IP

A token does not carry intellectual property. A signed document does, and the party that signed it has to be a person or a
legal entity. This page says what the app records about that, what it will and will not claim, and what a lawyer needs to check
before anyone relies on it. It is design and research, not legal advice.

## What the app records

Each launch can carry an **IP record**, written by the project's author on the launch page (**Who holds the IP**):

| Starting point | Meaning | What the page says |
|---|---|---|
| **Open licence** | The work is released under a named licence (MIT, CC-BY-4.0…). | Nobody, holders included, holds exclusive rights. |
| **No entity yet: the founders hold it** | The usual start. The founders own what they made, and each contributor owns their own contribution until they assign it in writing. Optionally the founders link a signed *commitment to assign* the IP to an entity once one is formed. | "The founders hold the IP themselves", or, with the commitment, "…and have committed to assign it". Holders have no claim yet, and the founders carry the legal risk personally. |
| **A legal entity holds it** | A named entity (name, where it is registered) and a signed *assignment* of the IP to it, optionally written to take effect only when the sale completes. Optionally the entity's operating agreement. | "To be assigned when the raise completes", then "The IP is assigned to the entity". Only with the operating agreement linked does it say holders are said to direct the entity. |

Documents are links (https only) pinned by a SHA-256 fingerprint, computed in the browser from the file so nobody pastes a hash by
hand. They can be changed later (the founder republishes the record), so the page shows the fingerprint, and a reader can check a
document against it.

The wording is derived from what is on record (`web/src/features/launchpad/lib/ip-record.ts`), so a project cannot show a stronger
standing than its documents support, and a malformed document is dropped, which can only lower the standing. No standing says
"holders own the IP" except the last one, and even that says it is the project's statement.

## What the app does not claim

- That a document is real, signed, or enforceable. It has not read them.
- That holding a token gives title to anything. The strongest example in this space says the opposite: VitaDAO's own tokenomics state
  that its token grants no ownership of the IP; rights come from separate agreements.
- That putting a fingerprint on a chain makes anything "copyrighted onchain". Copyright arises when a work is made. A fingerprint and
  timestamp are evidence of what existed when, not title, and an NFT or a token moving is not an assignment unless a signed written
  agreement says so (in the US a transfer of copyright ownership needs a signed writing: 17 U.S.C. §204(a)). Registering with a
  national copyright office is a separate step and is what lets you sue and claim statutory damages in some countries (in the US,
  17 U.S.C. §§411–412).

## Starting without an entity, and linking one later

This works, and it is the default. The legal act is the founder's signed assignment; the chain supplies the *when* and the *who agreed*:

1. At launch the founders hold the IP and may link a signed commitment to assign it to an entity once one exists.
2. When the raise completes, the project forms the entity (for example a cell of an existing Marshall Islands DAO LLC, or a Cayman
   segregated portfolio, as MetaDAO and Umia do), paying for it from the raise.
3. The founders sign the assignment to that entity; the project records the entity and the assignment. The standing becomes "assigned".

Today the app records steps 1 and 3. **Not built:** a holder vote that names the entity (the commitment would say "to the entity the
holders approve", and the vote's result would be linked from the record), and the entity's formation itself.

Contributors are the weak point. Until a contributor assigns their work in writing they own it, so the **terms for contributors**
document should exist from the first day a contribution is accepted. The record links it; **not built:** each contributor accepting
it when they claim (the claim would carry the accepted terms' fingerprint).

## Why a project can be sued, and who

Launching without an entity is not illegal by itself. The exposures are:

- **Founders and contributors, personally.** With no entity there is no liability shield. An infringement claim against the code, or a
  contract claim, lands on the people. This is the main practical reason to form an entity.
- **Holders, if the DAO is treated as a partnership.** As I understand it, US courts and regulators have treated unincorporated DAOs
  as general partnerships or unincorporated associations (the Ooki DAO and bZx matters), which can make active participants jointly
  liable. This is from general knowledge, not researched here: a lawyer must confirm it, and it differs by country.
- **The founders, to buyers, for what they said.** The sharpest risk is a claim that "holders own the IP" when nothing supports it. That
  is a misrepresentation claim, and it is why the app's wording is derived from the record and never from marketing.
- **Contributors, to the project,** who keep rights in anything they never assigned.

The app does not stop a project launching without an entity: it is not the regulator, and a gate would read as having vetted the
project. It makes the state explicit, says the risk plainly, and keeps the strong wording for the strong state.

## Entity options (cost and caveats from public sources)

- **MetaDAO**: a Marshall Islands DAO LLC parent over a Cayman SPC with one segregated portfolio per project; the founder's IP
  assignment to the project's portfolio is conditional on the raise reaching its minimum, and the founder becomes the operator under a
  service agreement. Its own filing places IP in the DAO LLC, not directly with holders; a third-party article describes it as holders
  owning it. The two disagree, so read the documents.
- **Umia**: Cayman segregated portfolios on a BORG-style structure; IP is in the entity. Its published pages do not state what IP
  rights holders get.
- **A series cell under an existing MIDAO DAO LLC**: the Marshall Islands DAO Act allows series and does not add reporting for a
  series. One governance proposal quotes about $9.5k to set up and $5k a year for a DAO LLC; treat that as unverified until MIDAO
  confirms it. Members can be pseudonymous, with one person identified to the registry.
- **Wyoming DUNA** (what the Majeur contracts render): a nonprofit, so wrong for a commercial project (OAv2 §4.8).
- **IP-NFTs (Molecule, VitaDAO)**: the NFT points at signed agreements, and a token is a membership in a pool under a written
  membership agreement. The pattern worth copying is "a record that points at signed documents", which is what this app does.
- **Story / DATA Foundation**: not used. The Programmable IP License is an off-chain legal text with on-chain registration, and the
  foundation has since moved to AI-data provenance.

## Questions for the lawyer

1. Can an assignment name an entity that does not exist until the raise completes, or must the entity exist first?
2. Is a Marshall Islands series a separate legal person that can hold IP, and does a token give membership interests, or does it need
   an extra agreement?
3. Does holder control over the IP, together with the Shares' exit right, make the token a security, and where?
4. Is a pre-signed commitment to assign "to the entity the holders approve" enforceable against a founder who later refuses?
5. Should Creaton operate any parent entity, or should a neutral steward (MIDAO, MetaLeX)?
6. What should the contributor terms say so that a contribution is assigned on acceptance, in the contributor's country?

## Sources

- [VitaDAO tokenomics (VDP-3)](https://gov.vitadao.com/t/vdp-3-vitadao-tokenomics-proposal/64): the token grants no ownership of the IP.
- [Molecule IP-NFT v2](https://molecule.xyz/blog/introducing-ip-nft-v2)
- [MetaDAO filing](https://blockworks.com/token-transparency/filing/metadao)
- [Marshall Islands DAO Act](https://pacliirms.austlii.edu.au/mh/legis/consol_act/daoa2022415.pdf)
- [A MIDAO price quote in a governance proposal](https://forum.minswap.org/t/mip01-incorporation-of-minswap-dao-llc-as-a-non-profit-dao-llc-in-the-republic-of-the-marshall-islands-and-adoption-of-a-new-governance-process-temp-check/6680)
- [DATA Foundation](https://docs.datafdn.org/introduction)
