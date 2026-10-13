// Avatar catalog. Must match the UI worker's avatar picker.
// Avatar ids are stored as plain strings in users.avatar.
const AVATARS = ['lantern', 'key', 'rose', 'crown', 'dove', 'moon', 'door', 'mask'];

const AVATAR_EMOJI = {
  lantern: '🪔',
  key: '🔑',
  rose: '🌹',
  crown: '👑',
  dove: '🕊️',
  moon: '🌙',
  door: '🚪',
  mask: '🎭',
};

function isValidAvatar(v) {
  return typeof v === 'string' && AVATARS.includes(v);
}

module.exports = { AVATARS, AVATAR_EMOJI, isValidAvatar };
