import "./App.css";
import { VideoConverter } from "@/features/converter/components/VideoConverter";
import { useEffect } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';

function App() {
  useEffect(() => {
    // Show window after browser paint
    requestAnimationFrame(() => {
      getCurrentWindow().show();
    });
  }, []);

  return <VideoConverter />;
}

export default App;
