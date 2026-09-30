// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OrgBinding} from "../src/OrgBinding.sol";
import {Moloch} from "majeur/src/Moloch.sol";

interface ISharesVotes {
    function delegate(address delegatee) external;
}

/// @notice JourneyGov — the governance leg of the journey
/// (`docs/agentic-governance-design.md` section 4, S1): summon a majeur DAO
/// (DeployOrgDao's pattern) and run a REAL `plain` proposal through the
/// decision-routed lifecycle:
///
///   self-delegate -> openProposal(id) -> castVote x2 -> state(Succeeded)
///     -> queue -> executeByVotes -> the config change lands onchain
///
/// It also pins the web composer's guarantee: `computeProposalId` offline
/// equals `Moloch.proposalId` onchain (the id binds `config`, which is how
/// `bumpConfig` emergency-invalidates). Prints the 47005 receipt payloads
/// (proposal/vote/execute — the D4 vocabulary) at the end.
///
/// Run via `scripts/journey-float.sh` (phase C) against a local anvil:
///
/// ```
/// anvil &
/// scripts/journey-float.sh
/// ```
contract JourneyGov is Script {
    uint256 internal constant TREASURY_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant VOTER_KEY =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    // The AGENT executor (S3): governance execution runs from an agent key,
    // not a human one — the receipts must show WHO acted.
    uint256 internal constant AGENT_KEY =
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        address treasury = vm.addr(TREASURY_KEY);
        address voter = vm.addr(VOTER_KEY);

        // ---- summon (DeployOrgDao's summonAndBind pattern) --------------
        vm.startBroadcast(TREASURY_KEY);
        OrgBinding binding = new OrgBinding();
        // The clone implementation for `SummonParams.molochImpl`:
        // `Summoner.implementation` is an unexported immutable (no getter
        // and no storage slot), so mirror the Summoner constructor's
        // `new Moloch{salt: bytes32(0)}()` — CREATE2(salt = 0) from the
        // summoner over Moloch's creation code.
        address molochImpl = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(binding.summoner()),
                            bytes32(0),
                            keccak256(type(Moloch).creationCode)
                        )
                    )
                )
            )
        );
        // The agent seat takes a small stake: the production proposal
        // threshold (> 0, enforced) gates `openProposal` on the proposer's
        // own votes, and in this journey the AGENT seat proposes.
        address[] memory holders = new address[](3);
        holders[0] = treasury;
        holders[1] = voter;
        holders[2] = vm.addr(AGENT_KEY);
        uint256[] memory initShares = new uint256[](3);
        initShares[0] = 1e18;
        initShares[1] = 1e18;
        initShares[2] = 1e17;
        // Governance: the SafeSummoner.summonFast preset values — threshold
        // = 1% of the total initial shares floored at 1 (its
        // `_defaultThreshold` formula), 3-day TTL, 1-day timelock. OrgBinding
        // enforces these are production-safe (the P2 fix).
        uint256 totalShares = initShares[0] + initShares[1] + initShares[2];
        uint96 proposalThreshold = uint96(totalShares / 100 == 0 ? 1 : totalShares / 100);
        OrgBinding.SummonParams memory p = OrgBinding.SummonParams({
            name: "Buzz Gov Journey",
            symbol: "GOV",
            uri: "https://relay.example/dao.json",
            quorumBps: 500,
            ragequittable: true,
            proposalThreshold: proposalThreshold,
            proposalTTL: 3 days,
            timelockDelay: 1 days,
            molochImpl: molochImpl,
            salt: keccak256("journey-gov"),
            holders: holders,
            shares: initShares
        });
        address daoAddr = binding.summonAndBind(bytes32(uint256(1)), p);
        Moloch dao = Moloch(payable(daoAddr));
        // ERC20Votes-style: holders self-delegate or their votes weigh nothing.
        ISharesVotes(address(dao.shares())).delegate(treasury);
        vm.stopBroadcast();

        vm.startBroadcast(VOTER_KEY);
        ISharesVotes(address(dao.shares())).delegate(voter);
        vm.stopBroadcast();

        // The forge simulation keeps one block number across batches, so
        // `openProposal`'s N-1 snapshot would precede the share mint and read
        // zero supply (majeur's TooEarly). Roll the SIM's block number; the
        // real node advances one block per tx by itself.
        vm.roll(block.number + 2);

        // ---- the plain proposal: raise the bps quorum to 600 ------------
        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(600)));
        bytes32 nonce = keccak256("journey-gov-1");
        uint256 id = dao.proposalId(0, daoAddr, 0, data, nonce);

        // The web composer computes this id OFFLINE from (dao, intent,
        // config); pin the equality here or vote-tx.ts has drifted.
        uint256 offline = uint256(
            keccak256(
                abi.encode(daoAddr, uint8(0), daoAddr, uint256(0), keccak256(data), nonce, dao.config())
            )
        );
        require(offline == id, "offline proposalId drift (vote-tx.ts vector)");

        // S3 A1: the proposal is DRAFTED and opened by an agent seat (the
        // human votes, the agent proposes and executes — receipts name who
        // acted at every step).
        vm.startBroadcast(AGENT_KEY);
        // The agent seat self-delegates first: with the production threshold
        // enforced, `openProposal` checks the proposer's CURRENT votes.
        ISharesVotes(address(dao.shares())).delegate(vm.addr(AGENT_KEY));
        dao.openProposal(id);
        vm.stopBroadcast();

        vm.startBroadcast(VOTER_KEY);
        dao.castVote(id, 1); // for — the human votes
        vm.stopBroadcast();

        vm.startBroadcast(TREASURY_KEY);
        dao.castVote(id, 1); // for
        vm.stopBroadcast();

        require(uint256(dao.state(id)) == uint256(Moloch.ProposalState.Succeeded), "Succeeded");

        vm.startBroadcast(TREASURY_KEY);
        dao.queue(id); // timelock countdown (the 1-day preset delay is real now)
        vm.stopBroadcast();

        // The production config carries a 1-day timelock and `executeByVotes`
        // reverts `Timelocked` before it elapses: warp the SIM past it (same
        // simulation-only semantics as the `vm.roll` note above — on a real
        // node the executor runs this a day after queueing).
        vm.warp(block.timestamp + 1 days + 1);

        // S3: the EXECUTOR is an agent seat — `executeByVotes` is
        // permissionless by design; the interesting fact is WHO performed it,
        // and the receipt says so.
        vm.startBroadcast(AGENT_KEY);
        (bool ok, ) = dao.executeByVotes(0, daoAddr, 0, data, nonce);
        require(ok, "executeByVotes failed");
        vm.stopBroadcast();

        require(dao.quorumBps() == 600, "the proposal really executed");
        require(uint256(dao.state(id)) == uint256(Moloch.ProposalState.Executed), "Executed");

        // ---- the receipts (47005 vocabulary, D4) ------------------------
        console2.log("GOV JOURNEY OK - a plain proposal executed onchain.");
        console2.log("DAO:", daoAddr);
        console2.log("kind:47005 proposal receipt (agent seat proposed):");
        console2.log(
            string(
                abi.encodePacked(
                    '{"kind":47005,"content":"{\\"table\\":\\"proposal\\",\\"proposal\\":\\"0x',
                    _hexUint(id),
                    '\\",\\"onchain\\":\\"',
                    _dec(id),
                    '\\",\\"actor\\":\\"agent\\",\\"proposer\\":\\"',
                    _hexAddr(vm.addr(AGENT_KEY)),
                    '\\"}"}'
                )
            )
        );
        console2.log("kind:47005 vote receipt (treasury, for):");
        console2.log(
            string(
                abi.encodePacked(
                    '{"kind":47005,"content":"{\\"table\\":\\"vote\\",\\"proposal\\":\\"0x',
                    _hexUint(id),
                    '\\",\\"vote\\":\\"for\\"}"}'
                )
            )
        );
        console2.log("kind:47005 execute receipt (agent seat executed):");
        console2.log(
            string(
                abi.encodePacked(
                    '{"kind":47005,"content":"{\\"table\\":\\"execute\\",\\"proposal\\":\\"0x',
                    _hexUint(id),
                    '\\",\\"actor\\":\\"agent\\",\\"executor\\":\\"',
                    _hexAddr(vm.addr(AGENT_KEY)),
                    '\\"}"}'
                )
            )
        );
    }

    function _hexUint(uint256 v) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v >> ((31 - i) * 8));
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }

    function _hexAddr(address a) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(40);
        bytes20 bb = bytes20(a);
        for (uint256 i = 0; i < 20; i++) {
            out[i * 2] = alphabet[uint8(bb[i]) >> 4];
            out[i * 2 + 1] = alphabet[uint8(bb[i]) & 0x0f];
        }
        return string(abi.encodePacked("0x", string(out)));
    }

    function _dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) {
            len++;
            n /= 10;
        }
        bytes memory out = new bytes(len);
        n = v;
        while (len != 0) {
            out[--len] = bytes1(uint8(48 + (n % 10)));
            n /= 10;
        }
        return string(out);
    }
}
