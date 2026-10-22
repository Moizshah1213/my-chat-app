import InboxList from '../components/inbox-list';
import { ChatIcon } from '@/components/icons';

/** Agent inbox: conversation list (search/status/assignee filters, live updates)
 *  beside an empty-thread placeholder until a conversation is picked. */
export default function ConversationsPage() {
  return (
    <div className="inbox">
      <InboxList />
      <div className="thread empty">
        <div className="ic">
          <ChatIcon size={26} />
        </div>
        <h3>Pick a conversation</h3>
        <p className="m">Select a chat on the left to read it and reply in real time.</p>
      </div>
    </div>
  );
}
