import 'dotenv/config';
import { db } from './dist/db/index.js';
import { sql } from 'drizzle-orm';

db.execute(sql`ALTER TABLE daily_checkin_schedules ADD COLUMN additional_user_ids jsonb DEFAULT '[]'::jsonb NOT NULL;`)
  .then(() => { console.log('Done'); process.exit(0); })
  .catch(console.error);
