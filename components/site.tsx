"use client";

import { useState } from "react";
import { ContactForm } from "@/components/contact-form";
import { TalkButton } from "@/components/talk-button";

export function Site() {
  const [tab, setTab] = useState<"home" | "contact">("home");

  return (
    <main className="page">
      <header className="nav">
        <button
          type="button"
          className="mark"
          onClick={() => setTab("home")}
        >
          bessi
        </button>
        <button
          type="button"
          className={tab === "contact" ? "nav-link is-on" : "nav-link"}
          onClick={() => setTab("contact")}
        >
          contact
        </button>
      </header>
      {tab === "home" ? (
        <section className="hero">
          <h1>hi, i&apos;m bessi.</h1>
          <TalkButton />
        </section>
      ) : (
        <section className="contact">
          <h1>say hello.</h1>
          <ContactForm />
        </section>
      )}
    </main>
  );
}
