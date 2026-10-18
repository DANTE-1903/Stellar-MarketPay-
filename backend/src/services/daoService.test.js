"use strict";

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });

jest.mock("../db/pool", () => ({
  query: mockQuery,
}));

// The DAO service never talks to Soroban yet — the on-chain submission paths
// are still TODOs. Mocking the client/registry keeps that fact explicit and
// lets the "not yet implemented" tests assert no contract call is made.
jest.mock("./sorobanClient", () => ({
  readContractValue: jest.fn().mockResolvedValue(null),
}));

jest.mock("./sorobanArbitratorRegistry", () => ({
  listArbitrators: jest.fn().mockResolvedValue([]),
  isArbitrator: jest.fn().mockResolvedValue(false),
  getArbitratorCount: jest.fn().mockResolvedValue(0),
  getArbitratorInfo: jest.fn().mockResolvedValue(null),
}));

const pool = require("../db/pool");
const sorobanClient = require("./sorobanClient");
const sorobanArbitratorRegistry = require("./sorobanArbitratorRegistry");
const {
  listProposals,
  getProposal,
  createProposal,
  castVote,
  finalizeExpiredProposals,
  executeProposal,
  listArbitrators,
  upsertArbitrator,
  voteForArbitrator,
  getTopArbitratorPanel,
  getTreasurySummary,
  VALID_TYPES,
  VALID_STATUSES,
} = require("./daoService");

const PROPOSER =
  "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";
const OTHER_VOTER =
  "GCCCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";
const ARBITRATOR_KEY =
  "GDDDDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";
const PROPOSAL_ID = "11111111-1111-1111-1111-111111111111";

function makeProposalRow(overrides = {}) {
  return {
    id: PROPOSAL_ID,
    title: "Fund the tooling grant",
    description: "Grant 500 XLM to the developer tooling working group.",
    type: "treasury",
    proposer: PROPOSER,
    amount: 500,
    recipient: OTHER_VOTER,
    status: "active",
    votes_for: 0,
    votes_against: 0,
    voting_ends_at: "2999-01-01T00:00:00.000Z",
    created_at: "2024-01-01T00:00:00.000Z",
    executed_at: null,
    quorum_reached: false,
    ...overrides,
  };
}

function expectHttpError(promise, statusCode, message) {
  return expect(promise).rejects.toMatchObject({
    message,
    statusCode,
  });
}

describe("daoService", () => {
  let logSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("exports", () => {
    it("exposes the supported proposal types and statuses", () => {
      expect(VALID_TYPES).toEqual([
        "treasury",
        "platform",
        "parameter",
        "arbitration",
      ]);
      expect(VALID_STATUSES).toEqual([
        "active",
        "passed",
        "rejected",
        "executed",
      ]);
    });
  });

  describe("createProposal", () => {
    it("creates a proposal and returns the mapped row", async () => {
      const row = makeProposalRow();
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: PROPOSAL_ID }] })
        .mockResolvedValueOnce({ rows: [row] });

      const result = await createProposal({
        title: "Fund the tooling grant",
        description: "Grant 500 XLM to the developer tooling working group.",
        type: "treasury",
        proposer: PROPOSER,
        amount: 500,
        recipient: OTHER_VOTER,
      });

      expect(result.id).toBe(PROPOSAL_ID);
      expect(result.title).toBe(row.title);
      expect(result.type).toBe("treasury");
      expect(result.status).toBe("active");
      expect(result.proposer).toBe(PROPOSER);
      expect(result.amount).toBe("500");
      expect(result.recipient).toBe(OTHER_VOTER);
      expect(result.votesFor).toBe(0);
      expect(result.votesAgainst).toBe(0);
      expect(result.quorumPercent).toBe(10);
      expect(result.quorumReached).toBe(false);
      expect(result.votingEndsAt).toBe(row.voting_ends_at);
      expect(result.executedAt).toBeUndefined();
    });

    it("inserts with the default 7 day voting window", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: PROPOSAL_ID }] })
        .mockResolvedValueOnce({ rows: [makeProposalRow()] });

      await createProposal({
        title: "Fund the tooling grant",
        description: "Grant 500 XLM.",
        type: "treasury",
        proposer: PROPOSER,
      });

      expect(pool.query).toHaveBeenCalledTimes(2);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO dao_proposals");
      expect(params[0]).toBe("Fund the tooling grant");
      expect(params[6]).toBe("7");
    });

    it("flattens/clamps votingDays into the 1..30 range", async () => {
      for (const [votingDays, expected] of [
        [45, "30"],
        [-5, "1"],
        [3, "3"],
      ]) {
        mockQuery.mockClear();
        pool.query
          .mockResolvedValueOnce({ rows: [{ id: PROPOSAL_ID }] })
          .mockResolvedValueOnce({ rows: [makeProposalRow()] });

        await createProposal({
          title: "Fund the tooling grant",
          description: "Grant 500 XLM.",
          type: "treasury",
          proposer: PROPOSER,
          votingDays,
        });

        expect(pool.query.mock.calls[0][1][6]).toBe(expected);
      }
    });

    it("rejects blank title or description with 400", async () => {
      await expectHttpError(
        createProposal({
          title: "   ",
          description: "Grant 500 XLM.",
          type: "treasury",
          proposer: PROPOSER,
        }),
        400,
        "Title and description are required",
      );
      await expectHttpError(
        createProposal({
          title: "Fund the tooling grant",
          description: "  ",
          type: "treasury",
          proposer: PROPOSER,
        }),
        400,
        "Title and description are required",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("rejects an unknown proposal type with 400", async () => {
      await expectHttpError(
        createProposal({
          title: "Fund the tooling grant",
          description: "Grant 500 XLM.",
          type: "coup",
          proposer: PROPOSER,
        }),
        400,
        "Type must be one of: treasury, platform, parameter, arbitration",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("rejects proposals from invalid/unauthorized Stellar keys with 400", async () => {
      await expectHttpError(
        createProposal({
          title: "Fund the tooling grant",
          description: "Grant 500 XLM.",
          type: "treasury",
          proposer: "not-a-key",
        }),
        400,
        "Invalid Stellar public key",
      );
      await expectHttpError(
        createProposal({
          title: "Fund the tooling grant",
          description: "Grant 500 XLM.",
          type: "treasury",
          proposer: undefined,
        }),
        400,
        "Invalid Stellar public key",
      );
      // lowercase keys are not valid Stellar addresses either
      await expectHttpError(
        createProposal({
          title: "Fund the tooling grant",
          description: "Grant 500 XLM.",
          type: "treasury",
          proposer: PROPOSER.toLowerCase(),
        }),
        400,
        "Invalid Stellar public key",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("turns a missing amount/recipient into NULLs", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: PROPOSAL_ID }] })
        .mockResolvedValueOnce({ rows: [makeProposalRow({ amount: null, recipient: null })] });

      await createProposal({
        title: "Fund the tooling grant",
        description: "Grant 500 XLM.",
        type: "treasury",
        proposer: PROPOSER,
      });

      const params = pool.query.mock.calls[0][1];
      expect(params[4]).toBeNull();
      expect(params[5]).toBeNull();
    });
  });

  describe("listProposals", () => {
    it("lists all proposals when no status filter is given", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeProposalRow()] });

      const proposals = await listProposals();

      expect(proposals).toHaveLength(1);
      expect(pool.query.mock.calls[0][1]).toEqual([]);
      expect(pool.query.mock.calls[0][0]).toContain("WHERE");
      expect(pool.query.mock.calls[0][0]).toContain("dao_proposals");
    });

    it("applies the status filter as the only parameter", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeProposalRow()] });

      const proposals = await listProposals({ status: "active" });

      expect(proposals).toHaveLength(1);
      expect(pool.query.mock.calls[0][1]).toEqual(["active"]);
    });

    it("marks quorum-reached proposals", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeProposalRow({ quorum_reached: true, votes_for: 120 })],
      });

      const [proposal] = await listProposals();

      expect(proposal.quorumReached).toBe(true);
      expect(proposal.votesFor).toBe(120);
    });
  });

  describe("getProposal", () => {
    it("404s for an unknown proposal", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expectHttpError(
        getProposal(PROPOSAL_ID),
        404,
        "Proposal not found",
      );
    });

    it("returns the mapped proposal", async () => {
      pool.query.mockResolvedValueOnce({ rows: [makeProposalRow()] });

      const proposal = await getProposal(PROPOSAL_ID);

      expect(proposal.id).toBe(PROPOSAL_ID);
      expect(proposal.quorumPercent).toBe(10);
    });
  });

  describe("castVote", () => {
    function activeProposalRow(overrides = {}) {
      return makeProposalRow(overrides);
    }

    it("records a vote with coerced support and default weight", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [activeProposalRow()] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [activeProposalRow({ votes_for: 1, quorum_reached: false })],
        });

      const result = await castVote({
        proposalId: PROPOSAL_ID,
        voter: OTHER_VOTER,
        support: 1,
      });

      const [sql, params] = pool.query.mock.calls[1];
      expect(sql).toContain("INSERT INTO dao_votes");
      expect(params).toEqual([PROPOSAL_ID, OTHER_VOTER, true, 1, null]);
      expect(result.votesFor).toBe(1);
    });

    it("stores an explicit weight and tx hash", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [activeProposalRow()] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [activeProposalRow()] });

      await castVote({
        proposalId: PROPOSAL_ID,
        voter: OTHER_VOTER,
        support: 0,
        weight: "5",
        txHash: "abc123",
      });

      expect(pool.query.mock.calls[1][1]).toEqual([
        PROPOSAL_ID,
        OTHER_VOTER,
        false,
        5,
        "abc123",
      ]);
    });

    it("rejects an invalid voter key with 400 and never touches the DB", async () => {
      await expectHttpError(
        castVote({
          proposalId: PROPOSAL_ID,
          voter: "GINVALID",
          support: true,
        }),
        400,
        "Invalid Stellar public key",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("404s when the proposal does not exist", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expectHttpError(
        castVote({ proposalId: "missing", voter: OTHER_VOTER, support: true }),
        404,
        "Proposal not found",
      );
    });

    it.each(["passed", "rejected", "executed"])(
      "rejects voting on a %s proposal with 400",
      async (status) => {
        pool.query.mockResolvedValueOnce({
          rows: [activeProposalRow({ status })],
        });

        await expectHttpError(
          castVote({ proposalId: PROPOSAL_ID, voter: OTHER_VOTER, support: true }),
          400,
          "Voting is closed for this proposal",
        );
        expect(pool.query).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects voting after the voting period has ended with 400", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          activeProposalRow({ voting_ends_at: "2020-01-01T00:00:00.000Z" }),
        ],
      });

      await expectHttpError(
        castVote({ proposalId: PROPOSAL_ID, voter: OTHER_VOTER, support: true }),
        400,
        "Voting period has ended",
      );
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("rejects a duplicate vote (double-vote prevented) with 409", async () => {
      // UNIQUE (proposal_id, voter) on dao_votes backs this: the INSERT
      // conflicts, rowCount is 0, and the vote is not recorded twice.
      pool.query
        .mockResolvedValueOnce({ rows: [activeProposalRow()] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expectHttpError(
        castVote({ proposalId: PROPOSAL_ID, voter: OTHER_VOTER, support: false }),
        409,
        "Duplicate vote: this address has already voted on this proposal",
      );
      expect(pool.query).toHaveBeenCalledTimes(2);
      expect(pool.query.mock.calls[1][0]).toContain("ON CONFLICT (proposal_id, voter)");
    });
  });

  describe("finalizeExpiredProposals", () => {
    it("marks passed arbitration proposals as pending on-chain execution (TODO not yet implemented)", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: PROPOSAL_ID, status: "passed", type: "arbitration" }],
      });

      await finalizeExpiredProposals();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("on-chain execution pending"),
      );
      // Not yet implemented: no Soroban call was made for the passing
      // arbitration proposal — registry read/write clients stay untouched.
      expect(sorobanClient.readContractValue).not.toHaveBeenCalled();
      expect(sorobanArbitratorRegistry.isArbitrator).not.toHaveBeenCalled();
    });

    it("stays silent for non-arbitration outcomes", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: PROPOSAL_ID, status: "passed", type: "treasury" },
          { id: "22222222-2222-2222-2222-222222222222", status: "rejected", type: "arbitration" },
        ],
      });

      await finalizeExpiredProposals();

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("propagates DB errors", async () => {
      pool.query.mockRejectedValueOnce(new Error("db down"));

      await expect(finalizeExpiredProposals()).rejects.toThrow("db down");
    });
  });

  describe("executeProposal", () => {
    it("executes a passed proposal and returns the executed row", async () => {
      const executedRow = makeProposalRow({
        status: "executed",
        executed_at: "2024-02-01T00:00:00.000Z",
      });
      pool.query
        .mockResolvedValueOnce({ rows: [makeProposalRow({ status: "passed" })] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [executedRow] });

      const result = await executeProposal(PROPOSAL_ID);

      expect(result.status).toBe("executed");
      expect(result.executedAt).toBe("2024-02-01T00:00:00.000Z");
      const [updateSql, updateParams] = pool.query.mock.calls[1];
      expect(updateSql).toContain("SET status = 'executed'");
      expect(updateParams).toEqual([PROPOSAL_ID]);
    });

    it("rejects execution of a proposal that is not passed", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeProposalRow({ status: "active" })],
      });

      await expectHttpError(
        executeProposal(PROPOSAL_ID),
        400,
        "Only passed proposals can be executed",
      );
      // No state change occurred
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("logs arbitration execution as pending on-chain (TODO not yet implemented)", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [makeProposalRow({ status: "passed", type: "arbitration" })],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            makeProposalRow({
              status: "executed",
              type: "arbitration",
              executed_at: "2024-02-01T00:00:00.000Z",
            }),
          ],
        });

      const result = await executeProposal(PROPOSAL_ID);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("on-chain tx pending"),
      );
      // Not yet implemented: the executor must still not touch the chain.
      expect(sorobanClient.readContractValue).not.toHaveBeenCalled();
      expect(sorobanArbitratorRegistry.isArbitrator).not.toHaveBeenCalled();
      expect(result.status).toBe("executed");
    });
  });

  describe("arbitrators", () => {
    it("listArbitrators delegates to the Soroban registry module", async () => {
      sorobanArbitratorRegistry.listArbitrators.mockResolvedValueOnce([
        { publicKey: ARBITRATOR_KEY, displayName: "Pane 1" },
      ]);

      const arbitrators = await listArbitrators();

      expect(arbitrators).toEqual([
        { publicKey: ARBITRATOR_KEY, displayName: "Pane 1" },
      ]);
    });

    it("getTopArbitratorPanel returns at most `limit` arbitrators", async () => {
      sorobanArbitratorRegistry.listArbitrators.mockResolvedValueOnce([
        { publicKey: ARBITRATOR_KEY },
        { publicKey: OTHER_VOTER },
        { publicKey: PROPOSER },
        { publicKey: "GEEEEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC" },
      ]);

      const panel = await getTopArbitratorPanel(3);

      expect(panel).toHaveLength(3);
    });

    it("upserts an arbitrator profile and maps the snake_case row", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            public_key: ARBITRATOR_KEY,
            display_name: "Pane 1",
            bio: "Facts over FOMO",
            votes_received: 3,
            disputes_resolved: 1,
            elected_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      const profile = await upsertArbitrator({
        publicKey: ARBITRATOR_KEY,
        displayName: "Pane 1",
        bio: "Facts over FOMO",
      });

      expect(profile).toEqual({
        publicKey: ARBITRATOR_KEY,
        displayName: "Pane 1",
        bio: "Facts over FOMO",
        votesReceived: 3,
        disputesResolved: 1,
        electedAt: "2024-01-01T00:00:00.000Z",
      });
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO dao_arbitrators");
      expect(sql).toContain("ON CONFLICT (public_key)");
    });

    it("rejects upserting an arbitrator with an invalid key", async () => {
      await expectHttpError(
        upsertArbitrator({ publicKey: "short", displayName: "nope" }),
        400,
        "Invalid Stellar public key",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("registers a new arbitrator and increments their vote weight", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [
            {
              public_key: ARBITRATOR_KEY,
              display_name: null,
              bio: null,
              votes_received: 0,
              disputes_resolved: 0,
              elected_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      sorobanArbitratorRegistry.listArbitrators.mockResolvedValueOnce([
        { publicKey: ARBITRATOR_KEY },
      ]);

      const arbitrators = await voteForArbitrator({
        voter: OTHER_VOTER,
        arbitratorKey: ARBITRATOR_KEY,
        weight: "5",
      });

      expect(arbitrators).toEqual([{ publicKey: ARBITRATOR_KEY }]);
      const updateCall = pool.query.mock.calls[1];
      expect(updateCall[0]).toContain("votes_received = votes_received +");
      expect(updateCall[1]).toEqual([ARBITRATOR_KEY, 5]);
    });

    it("defaults the arbitrator vote weight to 1", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [
            {
              public_key: ARBITRATOR_KEY,
              display_name: null,
              bio: null,
              votes_received: 0,
              disputes_resolved: 0,
              elected_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      sorobanArbitratorRegistry.listArbitrators.mockResolvedValueOnce([]);

      await voteForArbitrator({
        voter: OTHER_VOTER,
        arbitratorKey: ARBITRATOR_KEY,
        weight: "not-a-number",
      });

      expect(pool.query.mock.calls[1][1]).toEqual([ARBITRATOR_KEY, 1]);
    });

    it("rejects arbitrator votes from invalid voter or arbitrator keys", async () => {
      await expectHttpError(
        voteForArbitrator({ voter: "bad", arbitratorKey: ARBITRATOR_KEY }),
        400,
        "Invalid Stellar public key",
      );
      await expectHttpError(
        voteForArbitrator({ voter: OTHER_VOTER, arbitratorKey: "bad" }),
        400,
        "Invalid Stellar public key",
      );
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("getTreasurySummary", () => {
    it("returns the allocated XLM, active proposal count and quorum percent", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ allocated: 1500, active_proposals: 4 }],
      });

      const summary = await getTreasurySummary();

      expect(summary).toEqual({
        allocatedXlm: "1500",
        activeProposals: 4,
        quorumPercent: 10,
      });
      expect(pool.query.mock.calls[0][0]).toContain("FROM dao_proposals");
    });

    it("falls back to zero values when there are no proposals", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{}] });

      const summary = await getTreasurySummary();

      expect(summary).toEqual({
        allocatedXlm: "0",
        activeProposals: 0,
        quorumPercent: 10,
      });
    });
  });
});
