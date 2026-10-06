import assert from "node:assert";
import { TelenowClient } from "../src/lib/telenow.js";

async function runTests() {
  console.log("Starting Telenow Org API WhatsApp verification tests...");

  const dispatchedRequests: Array<{
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: any;
  }> = [];

  const mockApiKey = "vai_live_test_api_key_12345";
  const mockOrgId = "org_test_98765";
  const mockChannelId = "channel_abc_123";

  const client = new TelenowClient(mockApiKey);

  // Mock the private request method on the instance to capture and inspect calls
  (client as any).request = async (
    method: string,
    path: string,
    body?: any,
    idempotencyKey?: string,
    extraHeaders?: Record<string, string>,
  ) => {
    dispatchedRequests.push({ method, path, headers: extraHeaders, body });

    // Mock responses based on endpoints
    if (path === "/api/v1/me") {
      return { org_id: mockOrgId };
    }
    if (path === `/api/orgs/${mockOrgId}/whatsapp-hub/channels`) {
      return {
        success: true,
        data: {
          channels: [
            {
              id: mockChannelId,
              label: "Primary WhatsApp Support",
              phone: "+15551234567",
              kind: "cloud",
              status: "connected",
            },
          ],
        },
      };
    }
    if (path === `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/send`) {
      return {
        success: true,
        data: {
          wamid: "wamid.HBgLMTIzNDU2Nzg5MA==",
        },
      };
    }
    if (path === `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/send-template`) {
      return {
        success: true,
        data: {
          wamid: "wamid.TEMPLATE_99999",
        },
      };
    }
    if (path === `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/media`) {
      return {
        success: true,
        data: {
          mediaId: "5f0c2b1e-8d4a-4b6e-9c3f-2a7d1e0b9c84",
          mime: "application/pdf",
          filename: "document.pdf",
          bytes: 1024,
        },
      };
    }
    if (path === `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}`) {
      return { success: true };
    }

    return { success: true };
  };

  // Test 1: listWhatsAppChannels calls GET /api/orgs/{orgId}/whatsapp-hub/channels
  console.log("\n[Test 1] Testing listWhatsAppChannels...");
  const channels = await client.listWhatsAppChannels(mockOrgId);
  assert.strictEqual(channels.length, 1);
  assert.strictEqual(channels[0]?.id, mockChannelId);
  assert.strictEqual(channels[0]?.phone, "+15551234567");
  assert.strictEqual(channels[0]?.name, "Primary WhatsApp Support");
  assert.strictEqual(
    dispatchedRequests[dispatchedRequests.length - 1]?.path,
    `/api/orgs/${mockOrgId}/whatsapp-hub/channels`,
  );
  console.log("✓ listWhatsAppChannels passed");

  // Test 2: sendWhatsAppMessage with text passes `body` (NOT `message` or `text`)
  console.log("\n[Test 2] Testing sendWhatsAppMessage with text...");
  const sendTextResult = await client.sendWhatsAppMessage(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      message: "Hello from AgilityOS!",
    },
    mockOrgId,
  );
  assert.strictEqual(sendTextResult.wamid, "wamid.HBgLMTIzNDU2Nzg5MA==");
  const lastSendReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(
    lastSendReq?.path,
    `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/send`,
  );
  assert.strictEqual(lastSendReq?.body.to, "+15559876543");
  assert.strictEqual(lastSendReq?.body.body, "Hello from AgilityOS!");
  assert.strictEqual(lastSendReq?.body.message, undefined);
  assert.strictEqual(lastSendReq?.body.text, undefined);
  console.log("✓ sendWhatsAppMessage with text formatted payload correctly using `body`");

  // Test 3: sendWhatsAppMessage with media passes `mediaId` and `caption`
  console.log("\n[Test 3] Testing sendWhatsAppMessage with media...");
  const sendMediaResult = await client.sendWhatsAppMessage(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      mediaId: "5f0c2b1e-8d4a-4b6e-9c3f-2a7d1e0b9c84",
      caption: "Your training certificate",
    },
    mockOrgId,
  );
  assert.strictEqual(sendMediaResult.wamid, "wamid.HBgLMTIzNDU2Nzg5MA==");
  const lastMediaReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(
    lastMediaReq?.path,
    `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/send`,
  );
  assert.strictEqual(lastMediaReq?.body.to, "+15559876543");
  assert.strictEqual(lastMediaReq?.body.mediaId, "5f0c2b1e-8d4a-4b6e-9c3f-2a7d1e0b9c84");
  assert.strictEqual(lastMediaReq?.body.caption, "Your training certificate");
  assert.strictEqual(lastMediaReq?.body.body, undefined);
  console.log("✓ sendWhatsAppMessage with media formatted payload correctly");

  // Test 4: uploadWhatsAppMedia calls POST /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}/media
  console.log("\n[Test 4] Testing uploadWhatsAppMedia...");
  const mediaResult = await client.uploadWhatsAppMedia(
    mockChannelId,
    Buffer.from("dummy pdf content"),
    "guide.pdf",
    "application/pdf",
    mockOrgId,
  );
  assert.strictEqual(mediaResult.mediaId, "5f0c2b1e-8d4a-4b6e-9c3f-2a7d1e0b9c84");
  const lastUploadReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(
    lastUploadReq?.path,
    `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}/media`,
  );
  console.log("✓ uploadWhatsAppMedia targets Hub channel route");

  // Test 5: sendWhatsAppTemplate with approved templates
  console.log("\n[Test 5] Testing sendWhatsAppTemplate with approved templates...");

  // 5a. course_schedule_reminder (4 variables)
  const reminderResult = await client.sendWhatsAppTemplate(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      template: "course_schedule_reminder",
      variables: ["Alex", "Enterprise Objection Handling", "10:00 – 12:00 (Asia/Kolkata)", "Focus on budget objections today."],
    },
    mockOrgId,
  );
  assert.strictEqual(reminderResult.wamid, "wamid.TEMPLATE_99999");
  let lastReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(lastReq?.body.template, "course_schedule_reminder");
  assert.deepStrictEqual(lastReq?.body.variables, [
    "Alex",
    "Enterprise Objection Handling",
    "10:00 – 12:00 (Asia/Kolkata)",
    "Focus on budget objections today.",
  ]);
  console.log("✓ course_schedule_reminder (4 vars) passed");

  // 5b. course_learning_resource (5 variables)
  const resourceResult = await client.sendWhatsAppTemplate(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      template: "course_learning_resource",
      variables: ["Sarah", "Cold Call Discovery Mastery", "5-Step Playbook", "Review before next call", "https://app.agilityos.ai"],
    },
    mockOrgId,
  );
  assert.strictEqual(resourceResult.wamid, "wamid.TEMPLATE_99999");
  lastReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(lastReq?.body.template, "course_learning_resource");
  assert.strictEqual(lastReq?.body.variables.length, 5);
  console.log("✓ course_learning_resource (5 vars) passed");

  // 5c. practice_call_feedback (5 variables)
  const feedbackResult = await client.sendWhatsAppTemplate(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      template: "practice_call_feedback",
      variables: ["David", "Financial Objections", "85", "45% Rep / 55% AI", "Acknowledge the budget constraint first."],
    },
    mockOrgId,
  );
  assert.strictEqual(feedbackResult.wamid, "wamid.TEMPLATE_99999");
  lastReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(lastReq?.body.template, "practice_call_feedback");
  assert.strictEqual(lastReq?.body.variables.length, 5);
  console.log("✓ practice_call_feedback (5 vars) passed");

  // 5d. channel_connection_test (2 variables)
  const testPingResult = await client.sendWhatsAppTemplate(
    {
      channelId: mockChannelId,
      to: "+15559876543",
      template: "channel_connection_test",
      variables: ["Alex", "Acme Corp"],
    },
    mockOrgId,
  );
  assert.strictEqual(testPingResult.wamid, "wamid.TEMPLATE_99999");
  lastReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(lastReq?.body.template, "channel_connection_test");
  assert.deepStrictEqual(lastReq?.body.variables, ["Alex", "Acme Corp"]);
  console.log("✓ channel_connection_test (2 vars) passed");

  // Test 6: deleteWhatsAppChannel calls DELETE /api/orgs/{orgId}/whatsapp-hub/channels/{channelId}
  console.log("\n[Test 6] Testing deleteWhatsAppChannel...");
  const delResult = await client.deleteWhatsAppChannel(mockChannelId, mockOrgId);
  assert.strictEqual(delResult.success, true);
  const lastDelReq = dispatchedRequests[dispatchedRequests.length - 1];
  assert.strictEqual(
    lastDelReq?.path,
    `/api/orgs/${mockOrgId}/whatsapp-hub/channels/${mockChannelId}`,
  );
  assert.strictEqual(lastDelReq?.method, "DELETE");
  console.log("✓ deleteWhatsAppChannel passed");

  // Confirm NO requests to /api/app-whatsapp or /whatsapp/sessions/.../send were ever made
  const hasAppKeyReqs = dispatchedRequests.some((r) => r.path.includes("/api/app-whatsapp"));
  assert.strictEqual(hasAppKeyReqs, false, "Must not make any requests to /api/app-whatsapp");

  const hasBogusSessionSend = dispatchedRequests.some((r) =>
    r.path.includes("/whatsapp/sessions") && r.path.includes("/send"),
  );
  assert.strictEqual(hasBogusSessionSend, false, "Must not make requests to bogus session send");

  console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY! No fallback hits, 100% Org API compliance.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
