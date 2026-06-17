import React from 'react';
import { createRoot } from 'react-dom/client';
import { Welcome } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Welcome />
  </React.StrictMode>
);
