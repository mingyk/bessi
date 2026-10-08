import { ContactForm } from "@/components/contact-form";
import { DemoCall } from "@/components/demo-call";
import { TalkButton } from "@/components/talk-button";

const calls = [
  {
    time: "fri 6:48 pm",
    name: "reservations",
    does: "checks the time against your hours, takes a name and party size, and confirms it back.",
    say: "table for four at 7:30?",
    outcome: "booked · 4 at 7:30",
  },
  {
    time: "fri 7:05 pm",
    name: "the wait list",
    does: "gives the wait and how many parties are ahead, then adds them to the list.",
    say: "how long’s the wait right now?",
    outcome: "on the list · 3 ahead",
  },
  {
    time: "fri 7:21 pm",
    name: "to-go orders",
    does: "takes the order, reads back the total from your menu, and gives a pickup time.",
    say: "two bulgogi to go, please.",
    outcome: "$21.98 · ready 7:36",
  },
  {
    time: "sat 2:10 pm",
    name: "menu and prices",
    does: "answers from your menu, word for word. she won’t invent a dish or a price.",
    say: "what comes with combination 2?",
    outcome: "answered",
  },
  {
    time: "mon 3:12 pm",
    name: "hours, parking, deals",
    does: "knows when you’re open, where to park, and which deals run right now.",
    say: "is happy hour on today?",
    outcome: "until 5 pm",
  },
  {
    time: "sun 12:40 pm",
    name: "any language",
    does: "answers in the language your guest is speaking, and switches when they do.",
    say: "¿tienen mesa para dos?",
    outcome: "booked · in spanish",
  },
  {
    time: "tue 11:52 pm",
    name: "after hours",
    does: "picks up when you’re closed and tells them when you open next.",
    say: "are you open for lunch tomorrow?",
    outcome: "opens 11:30 am",
  },
];

const steps = [
  {
    title: "tell us about your place",
    body: "menu, hours, parking, deals, house rules. what you’d tell a new host on their first night.",
  },
  {
    title: "hear her first",
    body: "we set bessi up as your host, and you call her before any guest does.",
  },
  {
    title: "forward your calls",
    body: "every call, only the ones your staff can’t pick up, or only after hours. your number stays the same.",
  },
];

const questions = [
  {
    q: "does she replace my host?",
    a: "no. she takes the phone so your host can stay with the guests in front of them.",
  },
  {
    q: "what if a guest needs a person?",
    a: "she takes their name, number, and what they need, and passes it to you to follow up.",
  },
  {
    q: "what about calls that aren’t about the restaurant?",
    a: "she politely steers them back. she won’t chat about anything else on your line.",
  },
  {
    q: "what does it cost?",
    a: "it depends on how many calls you get. tell us a little about your restaurant and we’ll send a quote.",
  },
];

export function Site() {
  return (
    <div className="page">
      <header className="wrap nav">
        <a className="mark" href="#top">
          bessi
        </a>
        <nav aria-label="sections">
          <ul className="nav-links">
            <li className="nav-optional">
              <a href="#calls">what she does</a>
            </li>
            <li>
              <a href="#try">try a call</a>
            </li>
            <li>
              <a className="nav-cta" href="#contact">
                contact
              </a>
            </li>
          </ul>
        </nav>
      </header>

      <main id="top">
        <section className="wrap hero">
          <h1>
            hi, i&apos;m bessi.
          </h1>
          <p className="hero-lede">
            i answer your restaurant’s phone, so every call gets picked up.
          </p>
          <TalkButton
            idleLabel="tap to talk. ask me anything about bessi."
            liveLabel="tap to hang up"
          />
        </section>

        <section id="calls" className="section">
          <div className="wrap">
            <div className="section-head">
              <h2>
                a week of calls, handled.
              </h2>
              <p className="section-lede">
                it’s seven on a friday and the phone rings while your host is
                seating a six-top. bessi picks up, sounds like your front desk,
                and handles it start to finish.
              </p>
            </div>
            <ol className="calls">
              {calls.map((call) => (
                <li key={call.name}>
                  <span className="calls-time">{call.time}</span>
                  <div className="calls-what">
                    <h3>{call.name}</h3>
                    <p>{call.does}</p>
                  </div>
                  <p className="calls-say">“{call.say}”</p>
                  <span className="calls-outcome">{call.outcome}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="try" className="section section-flush">
          <div className="wrap">
            <DemoCall />
          </div>
        </section>

        <section id="setup" className="section">
          <div className="wrap">
            <div className="section-head">
              <h2>
                on your phone in three steps.
              </h2>
            </div>
            <ol className="steps">
              {steps.map((step, index) => (
                <li key={step.title}>
                  <span className="step-num">{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="questions" className="section">
          <div className="wrap">
            <div className="section-head">
              <h2>
                questions owners ask.
              </h2>
            </div>
            <dl className="faq">
              {questions.map((item) => (
                <div key={item.q}>
                  <dt>{item.q}</dt>
                  <dd>{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="contact" className="section section-flush">
          <div className="wrap">
            <div className="contact">
              <div className="contact-copy">
                <h2>
                  put bessi on your line.
                </h2>
                <p className="section-lede">
                  tell us about your restaurant and which calls you want off
                  your plate. we’ll set her up and get back to you.
                </p>
              </div>
              <ContactForm />
            </div>
          </div>
        </section>
      </main>

      <footer className="wrap foot">
        <span className="mark">bessi</span>
        <span>© 2026</span>
      </footer>
    </div>
  );
}
