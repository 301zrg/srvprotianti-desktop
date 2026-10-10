import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const html = readFileSync(resolve(import.meta.dirname, '../web-source/rooms.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'room page script exists');

function sandbox(rooms = []) {
  const rows = [];
  const actions = [];
  const nodes = new Map();
  const body = {set innerHTML(value) { if (value === '') rows.length = 0; }, appendChild(row) { rows.push(row); }};
  nodes.set('tbody', body);
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {addEventListener() {}, textContent: ''});
      return nodes.get(id);
    },
    createElement(tag) {
      if (tag === 'tr') {
        const row = {innerHTML: '', firstElementChild: {appendChild(button) { row.button = button; }}};
        return row;
      }
      return {addEventListener(event, handler) { this[event] = handler; }};
    }
  };
  const context = {
    document,
    fetch: async () => ({json: async () => ({rooms})}),
    window: {SrvproDesktop: {
      ladder: () => actions.push('ladder'),
      joinRoom: room => actions.push(['join', room.roomname]),
      watchRoom: room => actions.push(['watch', room.roomname])
    }},
    SrvproWeb: {
      getLanguage: () => 'zh',
      t: (translations, key) => translations[context.lang][key],
      init() {}
    }
  };
  return {context, rows, actions};
}

test('room types use server metadata and translate all supported categories', () => {
  const {context} = sandbox();
  runInNewContext(script.slice(0, script.indexOf('async function refresh()')) +
    '\nglobalThis.inspect = {roomTypeKey, friendlyName, modeName};', context);
  const types = ['ladder_match', 'random_single', 'random_match', 'random_tag', 'random_other',
    'ai_battle', 'arena_room', 'tournament_room', 'single_room', 'match_room', 'tag_room', 'unknown_room'];
  for (const language of ['zh', 'ja', 'en', 'ko']) {
    context.lang = language;
    for (const type of types) {
      const room = {roomname: 'M#TT,RANDOM#123', roommode: 1, roomtype: type, randommode: 'X'};
      assert.equal(context.inspect.roomTypeKey(room), type);
      assert.ok(context.inspect.friendlyName(room, type));
    }
  }
  context.lang = 'zh';
  assert.equal(context.inspect.roomTypeKey({roomname: 'MATCH#Friends', roommode: 1}), 'match_room');
  assert.equal(context.inspect.roomTypeKey({roomname: 'TAG#Friends', roommode: 2}), 'tag_room');
  assert.equal(context.inspect.roomTypeKey({roomname: 'M#TT,RANDOM#123', roommode: 1}), 'ladder_match');
  assert.equal(context.inspect.roomTypeKey({roomname: 'M#TT,RANDOM#spoof', roommode: 1}), 'match_room');
  assert.equal(context.inspect.modeName(9), 'UNKNOWN');
});

test('only a server-confirmed ladder waiting room starts TT matching', async () => {
  const rooms = [
    {roomname: 'M#TT,RANDOM#1', roommode: 1, roomtype: 'ladder_match', needpass: 'false', istart: 'wait', users: []},
    {roomname: 'M#TT,RANDOM#2', roommode: 1, roomtype: 'match_room', needpass: 'false', istart: 'wait', users: []},
    {roomname: 'MATCH#Friends', roommode: 1, roomtype: 'match_room', needpass: 'false', istart: 'wait', users: []}
  ];
  const {context, rows, actions} = sandbox(rooms);
  runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.length, 3);
  assert.ok(rows[1].innerHTML.includes('比赛房'));
  rows.forEach(row => row.button.click());
  assert.deepEqual(actions, ['ladder', ['join', 'M#TT,RANDOM#2'], ['join', 'MATCH#Friends']]);
});
