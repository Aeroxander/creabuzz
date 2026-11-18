# Voting rules study

Run: `node scripts/simulate-voting-rules.mjs --write`. Assumptions are listed at the top of the script; the numbers are a design aid, not evidence about real users.

```
Voting rules study (liveness = good proposals passed | safety = harmful proposals passed)

public turnout 0.05, adversary 0%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         89% |   7%         16% |   0%
  plain token vote (10% quorum, simple majority)                  92% |   7%         92% |   9%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  87% |   5%         79% |   1%

public turnout 0.05, adversary 8%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         89% |  15%         17% |   0%
  plain token vote (10% quorum, simple majority)                  90% |  15%         91% |  14%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  87% |  11%         73% |   4%

public turnout 0.05, adversary 18%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         83% |  30%         28% |   1%
  plain token vote (10% quorum, simple majority)                  84% |  30%         83% |  31%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  78% |  22%         56% |   7%

public turnout 0.15, adversary 0%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         93% |   5%         21% |   1%
  plain token vote (10% quorum, simple majority)                  94% |   6%         92% |   6%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  92% |   5%         79% |   2%

public turnout 0.15, adversary 8%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         92% |  13%         26% |   1%
  plain token vote (10% quorum, simple majority)                  92% |  13%         90% |   9%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  89% |   8%         72% |   3%

public turnout 0.15, adversary 18%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         86% |  27%         32% |   2%
  plain token vote (10% quorum, simple majority)                  86% |  27%         85% |  25%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  79% |  18%         56% |   6%

public turnout 0.3, adversary 0%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         96% |   3%         38% |   0%
  plain token vote (10% quorum, simple majority)                  96% |   3%         96% |   4%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  93% |   2%         83% |   0%

public turnout 0.3, adversary 8%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         95% |   9%         40% |   0%
  plain token vote (10% quorum, simple majority)                  95% |   9%         95% |   9%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  92% |   4%         78% |   1%

public turnout 0.3, adversary 18%, delegation 0, 1 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         89% |  30%         43% |   1%
  plain token vote (10% quorum, simple majority)                  89% |  30%         89% |  24%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  82% |  19%         62% |   4%

public turnout 0.05, adversary 0%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)          6% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  93% |   9%         92% |   9%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  89% |   6%         61% |   1%

public turnout 0.05, adversary 8%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)          6% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  91% |  17%         91% |  15%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  87% |  12%         55% |   2%

public turnout 0.05, adversary 18%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)          9% |   1%          0% |   0%
  plain token vote (10% quorum, simple majority)                  83% |  34%         84% |  31%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  77% |  25%         45% |   4%

public turnout 0.15, adversary 0%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)          7% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  93% |   5%         94% |   7%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  91% |   3%         65% |   1%

public turnout 0.15, adversary 8%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)          7% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  92% |  11%         93% |  13%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  88% |   6%         58% |   1%

public turnout 0.15, adversary 18%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         12% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  85% |  28%         86% |  27%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  79% |  18%         46% |   3%

public turnout 0.3, adversary 0%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         12% |   0%          0% |   0%
  plain token vote (10% quorum, simple majority)                  95% |   5%         95% |   5%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  93% |   3%         69% |   0%

public turnout 0.3, adversary 8%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         13% |   1%          0% |   0%
  plain token vote (10% quorum, simple majority)                  94% |  10%         94% |  11%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  91% |   6%         59% |   1%

public turnout 0.3, adversary 18%, delegation 0, 3 open at once
  rule                                                           small good|harm    large good|harm
  v3 as shipped (large: >50% of all Shares; small: >=20%)         21% |   1%          0% |   0%
  plain token vote (10% quorum, simple majority)                  88% |  23%         89% |  24%
  v2 as built (large: 20%, 66%, exclusive; small: 10%, 55%, reusable)  82% |  14%         46% |   2%

```
