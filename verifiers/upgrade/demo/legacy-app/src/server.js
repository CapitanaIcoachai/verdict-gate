'use strict';
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

app.get('/hello', (req, res) => {
  const who = req.param('who');
  res.sendfile('public/hello.html');
});

app.del('/session/:id', (req, res) => {
  res.json({ ok: true }, 200);
});

app.listen(3000);
