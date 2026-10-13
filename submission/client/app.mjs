// This is deliberately an unfinished UI, not a reference implementation.
const connection = document.querySelector('#connection');
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?after=0`);
socket.onopen = () => { connection.textContent = 'Connected'; };
socket.onclose = () => { connection.textContent = 'Disconnected'; };
socket.onerror = () => { connection.textContent = 'Connection error'; };
document.querySelector('#play').onclick = () => {
  document.querySelector('#result').textContent = 'Implement Play, recovery, controls and a result-driven timeline.';
};
// TODO: state machine, saved intent/cursor, reconnect, unique-round score and animation.
