"use client";

import { useCallback, useState } from "react";
import { TalkButton } from "@/components/talk-button";

const prompts = [
  "can i get a table for four tonight at seven?",
  "how long is the wait for two right now?",
  "i’d like two orders of galbi to go.",
  "what’s on happy hour?",
];

const menu = [
  ["galbi", "$19.99"],
  ["bulgogi", "$10.99"],
  ["kimchi pancake", "$10.99"],
  ["combination 2", "$49.99"],
];

export function DemoCall() {
  const [ended, setEnded] = useState(false);
  const onEnd = useCallback(() => setEnded(true), []);

  return (
    <div className="demo">
      <div className="demo-copy">
        <h2>
          call galbi steakhouse.
        </h2>
        <p className="section-lede">
          galbi is a made-up korean steakhouse with a real menu, hours, and
          deals. bessi is their host. call the way a guest would.
        </p>
        <p className="demo-label">things to try</p>
        <ul className="try-list">
          {prompts.map((prompt) => (
            <li key={prompt}>“{prompt}”</li>
          ))}
        </ul>
        {ended ? (
          <div className="demo-next" role="status">
            <p>that’s bessi on galbi’s line. want her answering yours?</p>
            <a className="button button-light" href="#contact">
              set up your restaurant
              <span aria-hidden>→</span>
            </a>
          </div>
        ) : (
          <p className="fine">
            calls run up to three minutes. your browser will ask for the mic.
          </p>
        )}
      </div>
      <div className="demo-phone">
        <div className="demo-place">
          <p className="demo-name">galbi steakhouse</p>
          <p className="demo-where">korean steakhouse · steakville, ca</p>
        </div>
        <TalkButton
          sessionPath="/api/session/demo"
          maxMs={180_000}
          decidePath="/api/jev"
          toolPath="/api/demo/tool"
          idleLabel="tap to call"
          liveLabel="tap to hang up"
          onEnd={onEnd}
        />
        <div className="menu-card">
          <p className="menu-title">tonight’s menu, in part</p>
          <ul>
            {menu.map(([item, price]) => (
              <li key={item}>
                <span>{item}</span>
                <span className="menu-dots" aria-hidden />
                <span className="menu-price">{price}</span>
              </li>
            ))}
          </ul>
          <p className="menu-note">happy hour weekdays 3–5 pm</p>
        </div>
      </div>
    </div>
  );
}
