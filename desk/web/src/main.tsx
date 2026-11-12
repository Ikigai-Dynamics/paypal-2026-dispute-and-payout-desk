import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ChatPanel } from "./chat/ChatPanel";

createRoot(document.getElementById("root")!).render(<App />);
const chat = document.createElement("div");
chat.id = "parley-chat-root";
document.body.appendChild(chat);
createRoot(chat).render(<ChatPanel />);
