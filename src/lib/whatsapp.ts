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
 */
export async function sendCourseWhatsappResource(input: {
  drill: DrillRow;
  user: { name?: string | null; phone?: string | null };
  resource: CourseWhatsappResource;
  customPhone?: string;
}): Promise<{ ok: boolean; wamid?: string; error?: string }> {
  const { drill, user, resource, customPhone } = input;
  const targetPhone = customPhone?.trim() || user.phone?.trim();

  if (!targetPhone) {
    return { ok: false, error: "Recipient has no phone number configured." };
  }

  try {
    const { client } = await getTelenowClientForOrg(drill.orgId);

    const message = renderWhatsappResourceMessage({
      courseTitle: drill.title,
      userName: user.name || "there",
      resource,
    });

    const res = await client.sendWhatsAppMessage({
      to: targetPhone,
      message,
    });

    return { ok: true, wamid: res.wamid };
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
