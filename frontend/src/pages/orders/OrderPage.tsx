import { useNavigate, useParams, useSearchParams } from 'react-router';
import { OrderView } from '../../components/projects/OrderView';
import { parseOrderSection, sectionParam } from '../../components/projects/orderSections';

/** The route `/projects/:id` — the order view on a page of its own; a deleted order goes back to the list. */
export function OrderPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // `workshop` — the section's 14/21 text scope (WS-13 E2 B02); keyed by id, so
  // another order starts from nothing: its tabs, drafts and dialogs (E3 F03).
  return (
    <div className="workshop">
      <OrderView
        key={idParam}
        id={Number(idParam)}
        onDeleted={() => navigate('/projects')}
        // The open section (F02): an unknown value reads as the plan and is not
        // rewritten by reading; a change replaces the entry, so Back leaves the
        // order and Forward comes back to the same tab.
        section={parseOrderSection(params.get('section'))}
        onSectionChange={(next) =>
          setParams(
            (prev) => {
              const out = new URLSearchParams(prev);
              if (sectionParam(next)) out.set('section', next);
              else out.delete('section');
              return out;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
