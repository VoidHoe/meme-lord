function createRouter(io) {
  function dispatch(event) {
    const { target } = event;
    const clients = io.sockets.sockets;

    if (!target) {
      clients.forEach(socket => {
        if (socket.discordUsername) socket.emit('drop', event);
      });
      return;
    }

    clients.forEach(socket => {
      if (socket.discordUsername === target) socket.emit('drop', event);
    });
  }

  return { dispatch };
}

module.exports = { createRouter };
