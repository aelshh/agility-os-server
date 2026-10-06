import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  drills,
  users,
  type CourseWhatsappResource,
  type DrillRow,
  type UserRow,
  type CourseEnrollmentRow,
} from "../db/schema.js";
import { getTelenowClientForOrg, TelenowError } from "./telenow.js";

export interface RenderResourceMessageInput {
  courseTitle: string;
  userName: string;
  resource: CourseWhatsappResource;
}

/**
 * Renders a formatted WhatsApp message with placeholder substitutions.
 */
export function renderWhatsappResourceMessage(input: RenderResourceMessageInput): string {
  const { courseTitle, userName, resource } = input;
  const rawCaption = resource.caption?.trim();

  let message = rawCaption || getDefaultCaptionTemplate(resource.type);

  const cleanUrl = resource.url?.trim() || "";
  const cleanTitle = resource.title?.trim() || "Training Resource";
  const cleanDesc = resource.description?.trim() || "";

  message = message
    .replace(/\{\{\s*user_name\s*\}\}/gi, userName || "there")
    .replace(/\{\{\s*course_title\s*\}\}/gi, courseTitle || "Course Training")
    .replace(/\{\{\s*resource_title\s*\}\}/gi, cleanTitle)
    .replace(/\{\{\s*resource_url\s*\}\}/gi, cleanUrl)
    .replace(/\{\{\s*description\s*\}\}/gi, cleanDesc);

  return message;
}

function getDefaultCaptionTemplate(type: CourseWhatsappResource["type"]): string {
  switch (type) {
    case "video":
      return "📚 *{{course_title}}*\n\nHi {{user_name}}! Here is your training video:\n🎥 *{{resource_title}}*\n{{description}}\n\n👉 Watch here: {{resource_url}}\n\n_AgilityOS AI Coaching_";
    case "pdf":
    case "document":
      return "📚 *{{course_title}}*\n\nHi {{user_name}}! Here is your reference guide:\n📄 *{{resource_title}}*\n{{description}}\n\n👉 Download: {{resource_url}}\n\n_AgilityOS AI Coaching_";
    default:
      return "📚 *{{course_title}}*\n\nHi {{user_name}}! Here is your learning resource:\n🔗 *{{resource_title}}*\n{{description}}\n\n👉 Link: {{resource_url}}\n\n_AgilityOS AI Coaching_";
  }
}

/**
 * Sends a single WhatsApp resource to a recipient via Telenow WhatsApp.
 * Prefers the pre-approved `course_learning_resource` template, falling back to free-form text.
 */
export async function sendCourseWhatsappResource(input: {
  drill: DrillRow;
  user: { name?: string | null; phone?: string | null };
  resource: CourseWhatsappResource;
  customPhone?: string;
  channelId?: string;
}): Promise<{ ok: boolean; wamid?: string; error?: string }> {
  const { drill, user, resource, customPhone, channelId } = input;
  const targetPhone = customPhone?.trim() || user.phone?.trim();

  if (!targetPhone) {
    return { ok: false, error: "Recipient has no phone number configured." };
  }

  try {
    const { client, org, telenowOrgId } = await getTelenowClientForOrg(drill.orgId);

    const targetChannelId =
      channelId || drill.whatsappChannelId || org.defaultWhatsappChannelId || undefined;

    const userName = user.name?.trim() || "there";
    const courseTitle = drill.title?.trim() || "Course Training";
    const resourceTitle = resource.title?.trim() || "Training Resource";
    const overview = resource.description?.trim() || "Review this material before your next practice call.";
    const accessLink = resource.url?.trim() || "https://app.agilityos.ai";

    let wamid: string | undefined;

    // 1. Try sending the official approved Meta template: course_learning_resource
    try {
      const res = await client.sendWhatsAppTemplate(
        {
          channelId: targetChannelId,
          to: targetPhone,
          template: "course_learning_resource",
          language: "en_US",
          variables: [userName, courseTitle, resourceTitle, overview, accessLink],
        },
        telenowOrgId,
      );
      wamid = res.wamid;
    } catch (templateErr) {
      console.warn(
        `[whatsapp] course_learning_resource template failed for ${targetPhone}, attempting text fallback:`,
        templateErr,
      );

      // 2. Fallback to free-form text if template is rejected or channel is in session
      const message = renderWhatsappResourceMessage({
        courseTitle: drill.title,
        userName,
        resource,
      });

      const res = await client.sendWhatsAppMessage(
        {
          to: targetPhone,
          message,
          channelId: targetChannelId,
        },
        telenowOrgId,
      );
      wamid = res.wamid;
    }

    return { ok: true, wamid };
  } catch (err) {
    const errorMsg =
      err instanceof TelenowError
        ? err.message
        : `Failed to dispatch WhatsApp message: ${(err as Error).message}`;
    console.error(`[whatsapp] Failed to send resource ${resource.id} to ${targetPhone}:`, err);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Dispatches the post-call performance scorecard and coaching debrief via WhatsApp template.
 * Prefers the pre-approved `practice_call_feedback` template, falling back to free-form text.
 */
export async function sendPracticeCallFeedback(input: {
  drill: DrillRow;
  user: { name?: string | null; phone?: string | null };
  score: number;
  talkRatio?: string | null | undefined;
  topCoachingTip?: string | null | undefined;
  channelId?: string | undefined;
}): Promise<{ ok: boolean; wamid?: string; error?: string }> {
  const { drill, user, score, talkRatio, topCoachingTip, channelId } = input;
  const targetPhone = user.phone?.trim();

  if (!targetPhone) {
    return { ok: false, error: "Recipient has no phone number configured." };
  }

  try {
    const { client, org, telenowOrgId } = await getTelenowClientForOrg(drill.orgId);
    const targetChannelId =
      channelId || drill.whatsappChannelId || org.defaultWhatsappChannelId || undefined;

    const userName = user.name?.trim() || "there";
    const courseTitle = drill.title?.trim() || "Course Training";
    const scoreStr = String(Math.round(score));
    const ratioStr = talkRatio?.trim() || "Balanced";
    const tipStr =
      topCoachingTip?.trim() ||
      "Great practice attempt! Keep deliberate practice active in your routine.";

    let wamid: string | undefined;

    // 1. Try sending the official approved Meta template: practice_call_feedback
    try {
      const res = await client.sendWhatsAppTemplate(
        {
          channelId: targetChannelId,
          to: targetPhone,
          template: "practice_call_feedback",
          language: "en_US",
          variables: [userName, courseTitle, scoreStr, ratioStr, tipStr],
        },
        telenowOrgId,
      );
      wamid = res.wamid;
    } catch (templateErr) {
      console.warn(
        `[whatsapp] practice_call_feedback template failed for ${targetPhone}, attempting text fallback:`,
        templateErr,
      );

      const fallbackMessage =
        `Hi ${userName}, great job completing your practice session for *${courseTitle}*!\n\n` +
        `⭐ *Score:* ${scoreStr}/100\n` +
        `🗣️ *Talk Ratio:* ${ratioStr}\n` +
        `💡 *Top Coaching Tip:* ${tipStr}\n\n` +
        `_AgilityOS AI Coaching_`;

      const res = await client.sendWhatsAppMessage(
        {
          channelId: targetChannelId,
          to: targetPhone,
          message: fallbackMessage,
        },
        telenowOrgId,
      );
      wamid = res.wamid;
    }

    return { ok: true, wamid };
  } catch (err) {
    const errorMsg =
      err instanceof TelenowError
        ? err.message
        : `Failed to dispatch WhatsApp feedback: ${(err as Error).message}`;
    console.error(`[whatsapp] Failed to send feedback to ${targetPhone}:`, err);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Automatically dispatches all "post_call" triggered WhatsApp resources to the learner.
 */
export async function sendPostCallResources(input: {
  drillId: string;
  userId: string;
}): Promise<{ sentCount: number; errors: string[] }> {
  const { drillId, userId } = input;

  const [drill] = await db
    .select()
    .from(drills)
    .where(eq(drills.id, drillId))
    .limit(1);

  if (!drill) {
    return { sentCount: 0, errors: ["Course not found."] };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || !user.phone) {
    return { sentCount: 0, errors: ["User or phone number not found."] };
  }

  const rawResources = Array.isArray(drill.whatsappResources)
    ? (drill.whatsappResources as CourseWhatsappResource[])
    : [];

  const postCallResources = rawResources.filter(
    (r) => r.enabled && r.deliveryTrigger === "post_call",
  );

  if (postCallResources.length === 0) {
    return { sentCount: 0, errors: [] };
  }

  let sentCount = 0;
  const errors: string[] = [];

  for (const resource of postCallResources) {
    const result = await sendCourseWhatsappResource({
      drill,
      user,
      resource,
    });

    if (result.ok) {
      sentCount++;
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { sentCount, errors };
}

/**
 * Automatically dispatches the post-call coaching scorecard debrief to the learner.
 */
export async function sendPostCallFeedback(input: {
  drillId: string;
  userId: string;
  score: number;
  talkRatio?: { agentWords?: number; customerWords?: number; agentTurns?: number; customerTurns?: number } | string | null | undefined;
  coachingTips?: Array<{ issue?: string; suggestion?: string }> | string | null | undefined;
}): Promise<{ ok: boolean; wamid?: string; error?: string }> {
  const { drillId, userId, score, talkRatio, coachingTips } = input;

  const [drill] = await db
    .select()
    .from(drills)
    .where(eq(drills.id, drillId))
    .limit(1);

  if (!drill) {
    return { ok: false, error: "Course not found." };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || !user.phone) {
    return { ok: false, error: "User or phone number not found." };
  }

  // Format talk ratio string
  let ratioStr = "Balanced";
  if (typeof talkRatio === "string" && talkRatio.trim()) {
    ratioStr = talkRatio.trim();
  } else if (talkRatio && typeof talkRatio === "object") {
    const repWords = talkRatio.customerWords ?? 0;
    const aiWords = talkRatio.agentWords ?? 0;
    const total = repWords + aiWords;
    if (total > 0) {
      const repPct = Math.round((repWords / total) * 100);
      const aiPct = 100 - repPct;
      ratioStr = `${repPct}% Rep / ${aiPct}% AI`;
    }
  }

  // Format top coaching tip
  let tipStr = "Great practice attempt! Keep deliberate practice active in your routine.";
  if (typeof coachingTips === "string" && coachingTips.trim()) {
    tipStr = coachingTips.trim();
  } else if (Array.isArray(coachingTips) && coachingTips.length > 0) {
    const firstTip = coachingTips[0];
    if (firstTip?.suggestion?.trim()) {
      tipStr = firstTip.suggestion.trim();
    } else if (firstTip?.issue?.trim()) {
      tipStr = firstTip.issue.trim();
    }
  }

  return await sendPracticeCallFeedback({
    drill,
    user,
    score,
    talkRatio: ratioStr,
    topCoachingTip: tipStr,
  });
}

