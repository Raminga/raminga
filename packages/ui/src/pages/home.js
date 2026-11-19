// Agent-led home composition. The hero and activity modules are kept
// separate so neither fake Agent identity nor inferred rest state can leak in.
export {
  buildHomeAgentModel,
  renderHomeAgent,
  renderHomeHuman,
} from './home-agent.js';
export {
  buildHomeActivity,
  renderActivityDetail,
  renderHomeActivity,
} from '../components/activity-strip.js';
