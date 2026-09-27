package v1

import (
	"context"
	stderrors "errors"
	"log/slog"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

// convertMemoListFromStore turns a page of stored memos into API messages,
// loading reactions, attachments, relations and creators in one batch each
// rather than per memo. Order is preserved, so a caller that chose the order —
// the daily review draws its own — keeps it.
//
// A memo whose creator no longer exists is skipped rather than failing the
// whole page: one broken row must not make a list unreadable.
func (s *APIV1Service) convertMemoListFromStore(ctx context.Context, memos []*store.Memo) ([]*v1pb.Memo, error) {
	memoMessages := []*v1pb.Memo{}
	if len(memos) == 0 {
		return memoMessages, nil
	}

	reactionMap := make(map[int32][]*store.Reaction)

	attachmentMap := make(map[int32][]*store.Attachment)
	memoIDs := make([]int32, 0, len(memos))

	for _, m := range memos {
		memoIDs = append(memoIDs, m.ID)
	}

	// REACTIONS
	reactions, err := s.Store.ListReactions(ctx, &store.FindReaction{MemoIDList: memoIDs})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list reactions")
	}
	for _, reaction := range reactions {
		reactionMap[reaction.MemoID] = append(reactionMap[reaction.MemoID], reaction)
	}

	// ATTACHMENTS
	attachments, err := s.Store.ListAttachments(ctx, &store.FindAttachment{MemoIDList: memoIDs})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list attachments")
	}
	for _, attachment := range attachments {
		attachmentMap[*attachment.MemoID] = append(attachmentMap[*attachment.MemoID], attachment)
	}

	// RELATIONS (batch load to avoid N+1)
	relationMap, err := s.batchConvertMemoRelations(ctx, memos, false)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to batch load memo relations")
	}
	creatorIDs := make([]int32, 0, len(memos)+len(reactions))
	for _, memo := range memos {
		creatorIDs = append(creatorIDs, memo.CreatorID)
	}
	for _, reaction := range reactions {
		creatorIDs = append(creatorIDs, reaction.CreatorID)
	}
	creatorMap, err := s.listUsersByID(ctx, creatorIDs)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list memo creators: %v", err)
	}
	for _, memo := range memos {
		reactions := reactionMap[memo.ID]
		attachments := attachmentMap[memo.ID]
		relations := relationMap[memo.ID]

		memoMessage, err := s.convertMemoFromStoreWithCreators(ctx, memo, reactions, attachments, relations, creatorMap)
		if err != nil {
			if stderrors.Is(err, errMemoCreatorNotFound) {
				slog.Warn("Skipping memo with missing creator",
					slog.Int64("memo_id", int64(memo.ID)),
					slog.String("memo_uid", memo.UID),
					slog.Int64("creator_id", int64(memo.CreatorID)),
				)
				continue
			}
			return nil, errors.Wrap(err, "failed to convert memo")
		}

		memoMessages = append(memoMessages, memoMessage)
	}

	return memoMessages, nil
}
