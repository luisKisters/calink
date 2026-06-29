import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "prune cancelled events and changelog",
  { hourUTC: 3, minuteUTC: 15 },
  internal.maintenance.prune,
  { cancelledRetentionDays: 30, maxChangeLogPerCalendar: 200 },
);

export default crons;
