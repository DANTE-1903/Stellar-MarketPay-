"use strict";

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });

jest.mock("../db/pool", () => ({
  query: mockQuery,
}));

// Fork the limiter in tests: express-rate-limit stores counters in memory per
// instance, and the governance tests only exercise auth/permission gating.
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../services/daoService", () => ({
  finalizeExpiredProposals: jest.fn().mockResolvedValue(undefined),
  listProposals: jest.fn().mockResolvedValue([]),
  getProposal: jest.fn().mockResolvedValue({}),
  createProposal: jest.fn(),
  castVote: jest.fn(),
  executeProposal: jest.fn(),
  getTreasurySummary: jest.fn().mockResolvedValue({}),
  listArbitrators: jest.fn().mockResolvedValue([]),
  getTopArbitratorPanel: jest.fn().mockResolvedValue([]),
  upsertArbitrator: jest.fn(),
  voteForArbitrator: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const daoService = require("../services/daoService");
const { verifyJWT, requireAdminRole } = require("../middleware/auth");

const USER_KEY = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";
const ADMIN_KEY = "GCCCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";
const PROPOSAL_ID = "11111111-1111-1111-1111-111111111111";

const app = express();
app.use(express.json());
app.use("/api/dao", require("./dao"));
// Mirror the server's error translation for services that attach statusCode.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

const userToken = jwt.sign(
  { publicKey: USER_KEY, role: "user" },
  process.env.JWT_SECRET,
);
const adminToken = jwt.sign(
  { publicKey: ADMIN_KEY, role: "admin" },
  process.env.JWT_SECRET,
);

describe("DAO routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    daoService.listProposals.mockResolvedValue([]);
    daoService.getProposal.mockResolvedValue({});
    daoService.createProposal.mockReset();
    daoService.castVote.mockReset();
    daoService.executeProposal.mockReset();
  });

  describe("GET /proposals (public)", () => {
    it("finalizes expired proposals then lists them", async () => {
      const res = await request(app).get("/api/dao/proposals");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(daoService.finalizeExpiredProposals).toHaveBeenCalledTimes(1);
      expect(daoService.finalizeExpiredProposals.mock.invocationCallOrder[0])
        .toBeLessThan(daoService.listProposals.mock.invocationCallOrder[0]);
    });

    it("forwards the status filter", async () => {
      await request(app).get("/api/dao/proposals?status=passed");

      expect(daoService.listProposals).toHaveBeenCalledWith({
        status: "passed",
      });
    });
  });

  describe("GET /proposals/:id (public)", () => {
    it("returns the proposal", async () => {
      daoService.getProposal.mockResolvedValueOnce({ id: PROPOSAL_ID });

      const res = await request(app).get(`/api/dao/proposals/${PROPOSAL_ID}`);

      expect(res.status).toBe(200);
      expect(daoService.getProposal).toHaveBeenCalledWith(PROPOSAL_ID);
    });

    it("surfaces the service 404 for unknown ids", async () => {
      daoService.getProposal.mockRejectedValueOnce(
        Object.assign(new Error("Proposal not found"), { statusCode: 404 }),
      );

      const res = await request(app).get("/api/dao/proposals/unknown");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Proposal not found");
    });
  });

  describe("POST /proposals", () => {
    it("rejects an unauthorized caller with 401 and never reaches the service", async () => {
      const res = await request(app)
        .post("/api/dao/proposals")
        .send({ title: "x", description: "y", type: "treasury" });

      expect(res.status).toBe(401);
      expect(daoService.createProposal).not.toHaveBeenCalled();
    });

    it("rejects an invalid token with 401", async () => {
      const res = await request(app)
        .post("/api/dao/proposals")
        .set("Authorization", "Bearer not.a.jwt")
        .send({ title: "x", description: "y", type: "treasury" });

      expect(res.status).toBe(401);
      expect(daoService.createProposal).not.toHaveBeenCalled();
    });

    it("creates a proposal for an authenticated wallet", async () => {
      daoService.createProposal.mockResolvedValueOnce({ id: PROPOSAL_ID });

      const res = await request(app)
        .post("/api/dao/proposals")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          title: "Fund the tooling grant",
          description: "500 XLM.",
          type: "treasury",
          amount: 500,
        });

      expect(res.status).toBe(201);
      expect(daoService.createProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fund the tooling grant",
          type: "treasury",
          proposer: USER_KEY,
        }),
      );
    });

    it("propagates validation errors from the service", async () => {
      daoService.createProposal.mockRejectedValueOnce(
        Object.assign(new Error("Type must be one of: treasury, platform, parameter, arbitration"), {
          statusCode: 400,
        }),
      );

      const res = await request(app)
        .post("/api/dao/proposals")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ title: "x", description: "y", type: "coup" });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /proposals/:id/vote", () => {
    it("rejects an unauthorized caller with 401 and never reaches the service", async () => {
      const res = await request(app)
        .post(`/api/dao/proposals/${PROPOSAL_ID}/vote`)
        .send({ support: true });

      expect(res.status).toBe(401);
      expect(daoService.castVote).not.toHaveBeenCalled();
    });

    it("records a vote for an authenticated wallet", async () => {
      daoService.castVote.mockResolvedValueOnce({ id: PROPOSAL_ID });

      const res = await request(app)
        .post(`/api/dao/proposals/${PROPOSAL_ID}/vote`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ support: true, weight: 2 });

      expect(res.status).toBe(200);
      expect(daoService.castVote).toHaveBeenCalledWith(
        expect.objectContaining({
          proposalId: PROPOSAL_ID,
          voter: USER_KEY,
          support: true,
          weight: 2,
        }),
      );
    });
  });

  describe("POST /proposals/:id/execute (admin only)", () => {
    it("rejects an anonymous caller with 401", async () => {
      const res = await request(app).post(`/api/dao/proposals/${PROPOSAL_ID}/execute`);

      expect(res.status).toBe(401);
      expect(daoService.executeProposal).not.toHaveBeenCalled();
    });

    it("rejects a non-admin wallet with 403 before execution", async () => {
      const res = await request(app)
        .post(`/api/dao/proposals/${PROPOSAL_ID}/execute`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Admin access required");
      expect(daoService.executeProposal).not.toHaveBeenCalled();
    });

    it("allows an admin to execute", async () => {
      daoService.executeProposal.mockResolvedValueOnce({
        id: PROPOSAL_ID,
        status: "executed",
      });

      const res = await request(app)
        .post(`/api/dao/proposals/${PROPOSAL_ID}/execute`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(daoService.executeProposal).toHaveBeenCalledWith(PROPOSAL_ID);
    });
  });

  describe("GET /treasury (public)", () => {
    it("returns the treasury summary", async () => {
      daoService.getTreasurySummary.mockResolvedValueOnce({
        allocatedXlm: "0",
        activeProposals: 0,
        quorumPercent: 10,
      });

      const res = await request(app).get("/api/dao/treasury");

      expect(res.status).toBe(200);
      expect(res.body.data.quorumPercent).toBe(10);
    });
  });

  describe("arbitrator routes", () => {
    it("lists arbitrators publicly", async () => {
      daoService.listArbitrators.mockResolvedValue([
        { publicKey: ADMIN_KEY, onChain: false },
      ]);

      const res = await request(app).get("/api/dao/arbitrators");

      expect(res.status).toBe(200);
      expect(res.body.data.arbitrators).toHaveLength(1);
      expect(daoService.getTopArbitratorPanel).toHaveBeenCalledWith(3);
    });

    it("404s for an unknown arbitrator key", async () => {
      daoService.listArbitrators.mockResolvedValueOnce([]);

      const res = await request(app).get("/api/dao/arbitrators/nobody");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Arbitrator not found");
    });

    it("rejects arbitrator registration without a JWT", async () => {
      const res = await request(app)
        .post("/api/dao/arbitrators")
        .send({ displayName: "Pane 1" });

      expect(res.status).toBe(401);
      expect(daoService.upsertArbitrator).not.toHaveBeenCalled();
    });

    it("rejects arbitrator votes without a JWT", async () => {
      const res = await request(app)
        .post(`/api/dao/arbitrators/${ADMIN_KEY}/vote`)
        .send({ weight: 1 });

      expect(res.status).toBe(401);
      expect(daoService.voteForArbitrator).not.toHaveBeenCalled();
    });

    it("records an arbitrator vote for an authenticated wallet", async () => {
      daoService.voteForArbitrator.mockResolvedValueOnce([
        { publicKey: ADMIN_KEY },
      ]);

      const res = await request(app)
        .post(`/api/dao/arbitrators/${ADMIN_KEY}/vote`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ weight: 3 });

      expect(res.status).toBe(200);
      expect(daoService.voteForArbitrator).toHaveBeenCalledWith({
        voter: USER_KEY,
        arbitratorKey: ADMIN_KEY,
        weight: 3,
      });
    });
  });

  describe("auth middleware exposure", () => {
    it("still exports verifyJWT/requireAdminRole used by the router", () => {
      expect(typeof verifyJWT).toBe("function");
      expect(typeof requireAdminRole).toBe("function");
    });
  });
});
