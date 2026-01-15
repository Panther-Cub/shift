import "./App.css";
import { VideoConverter } from "@/features/converter/components/VideoConverter";
import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";

function App() {
  useEffect(() => {
    requestAnimationFrame(() => {
      void emit("app-ready");
    });
  }, []);

  return <VideoConverter />;
}

export default App;
